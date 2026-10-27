import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type {
  BamEntry,
  BamStatusSummary,
  ConnectionOptions,
  FlowJob,
  Instance,
  JobSpyInterface,
  ListOptions,
  PgBoss,
  PgBossEventMap,
  PreviewScheduleOptions,
  QueueResult,
  ReindexOptions,
  Schedule,
  SchemaDriftReport,
  SendOptions,
  SuperviseOptions,
  WipData,
} from 'pg-boss';
import { MODULE_OPTIONS_TOKEN } from './pg-boss.module-definition.js';
import { PGBOSS_INSTANCE, PGBOSS_LOGGER_CONTEXT } from './pg-boss.constants.js';
import type { PgBossModuleOptions } from './interfaces/pg-boss-module-options.interface.js';
import { QueueRegistry } from './queue/queue.registry.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Owns shutdown of the pg-boss instance and exposes it for anything the module doesn't wrap.
 * Call `app.enableShutdownHooks()` so SIGTERM drains in-flight jobs before the process exits.
 *
 * Shutdown runs in two phases so a job that is still running can finish its last queries:
 *  1. `beforeApplicationShutdown` stops the workers and waits for running handlers. Every other
 *     module (a database connection, an HTTP client) is still alive at this point.
 *  2. `onApplicationShutdown` closes pg-boss's own connection pool.
 */
@Injectable()
export class PgBossService implements BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(PGBOSS_LOGGER_CONTEXT);

  constructor(
    @Inject(PGBOSS_INSTANCE) readonly boss: PgBoss,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PgBossModuleOptions,
    @Inject(QueueRegistry) private readonly registry: QueueRegistry,
  ) {}

  async beforeApplicationShutdown(): Promise<void> {
    const { graceful = true, timeout = DEFAULT_TIMEOUT_MS } = this.options.stop ?? {};
    await this.stop({ close: false, graceful, timeout });
  }

  async onApplicationShutdown(): Promise<void> {
    // `stop: { close: false }` is for callers who share the pool and close it themselves.
    if (this.options.stop?.close === false) {
      return;
    }
    await this.stop({ close: true });
  }

  /** True when the database answers. Suited to a readiness probe. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.boss.getDb().executeSql('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  // Flows and pub/sub span queues, so they live here instead of on a `JobQueue`.

  /**
   * Create jobs and the dependencies between them in one transaction. A job with `dependsOn` stays
   * blocked until every parent has completed. pg-boss requires at least two jobs. Returns the created job id for each `ref`.
   *
   * Every queue a flow names is created first if it doesn't exist yet, so a flow can't fail on a
   * queue that was declared but not yet ensured. If a parent fails or is cancelled, its dependents
   * stay blocked until you cancel or fail them.
   */
  async flow(jobs: FlowJob[], options?: ConnectionOptions): Promise<Record<string, string>> {
    await Promise.all([...new Set(jobs.map((job) => job.name))].map((name) => this.registry.ensure(name)));
    return this.boss.flow(jobs, options);
  }

  /** Run a flow resolution pass now instead of waiting for `flowIntervalSeconds`. Useful in tests. */
  resolveFlow(): Promise<void> {
    return this.boss.resolveFlow();
  }

  /** Send a job to every queue subscribed to `event` (see `JobQueue.subscribe`). */
  publish(event: string, data?: object, options?: SendOptions): Promise<void> {
    return this.boss.publish(event, data, options);
  }

  // Inspection.

  getQueues(names?: string[], options?: ListOptions): Promise<QueueResult[]> {
    return this.boss.getQueues(names, options);
  }

  /** The pg-boss instances connected to this schema, with their workers and metrics. */
  getInstances(options?: ListOptions): Promise<Instance[]> {
    return this.boss.getInstances(options);
  }

  /** Schedules across queues, or for one queue and key. */
  getSchedules(name?: string, key?: string, options?: ListOptions<Pick<Schedule, 'name' | 'key'>>): Promise<Schedule[]> {
    return this.boss.getSchedules(name, key, options);
  }

  /** The next run times of a cron expression or recurrence rule, without scheduling anything. */
  previewSchedule(cron: string, options?: PreviewScheduleOptions): Date[] {
    return this.boss.previewSchedule(cron, options);
  }

  /** What this process's workers are running right now. */
  getWipData(options?: { includeInternal?: boolean }): WipData[] {
    return this.boss.getWipData(options);
  }

  getBamStatus(): Promise<BamStatusSummary[]> {
    return this.boss.getBamStatus();
  }

  getBamEntries(options?: ListOptions): Promise<BamEntry[]> {
    return this.boss.getBamEntries(options);
  }

  isInstalled(): Promise<boolean> {
    return this.boss.isInstalled();
  }

  schemaVersion(): Promise<number | null> {
    return this.boss.schemaVersion();
  }

  detectSchemaDrift(): Promise<SchemaDriftReport> {
    return this.boss.detectSchemaDrift();
  }

  /** The `REINDEX` statements for bloated job indexes, for installs where pg-boss can't run them itself. */
  getReindexCommands(options?: ReindexOptions): Promise<string[]> {
    return this.boss.getReindexCommands(options);
  }

  // Background work.

  isMaintaining(): boolean {
    return this.boss.isMaintaining();
  }

  isBamWorking(): boolean {
    return this.boss.isBamWorking();
  }

  isResolvingFlow(): boolean {
    return this.boss.isResolvingFlow();
  }

  isCheckingSkew(): boolean {
    return this.boss.isCheckingSkew();
  }

  isTimekeeping(): boolean {
    return this.boss.isTimekeeping();
  }

  /** Run maintenance now, for one queue or all of them. */
  supervise(name?: string, options?: SuperviseOptions): Promise<void> {
    return this.boss.supervise(name, options);
  }

  /** Wake a worker so it polls now. */
  notifyWorker(workerId: string): void {
    this.boss.notifyWorker(workerId);
  }

  /** Delete every job in one queue, or in all queues when `name` is omitted. */
  deleteAllJobs(name?: string): Promise<number | null> {
    return this.boss.deleteAllJobs(name);
  }

  // Events and testing.

  /** Listen to pg-boss events (`error`, `warning`, `flow`, ...). `error` and `warning` are already logged. */
  on<E extends keyof PgBossEventMap>(event: E, listener: (...args: PgBossEventMap[E]) => void): this {
    this.boss.on(event, listener as never);
    return this;
  }

  off<E extends keyof PgBossEventMap>(event: E, listener: (...args: PgBossEventMap[E]) => void): this {
    this.boss.off(event, listener as never);
    return this;
  }

  /** pg-boss's job spy, for asserting on jobs in tests. */
  getSpy<T = object>(name: string): JobSpyInterface<T> {
    return this.boss.getSpy<T>(name);
  }

  clearSpies(): void {
    this.boss.clearSpies();
  }

  private async stop(options: Parameters<PgBoss['stop']>[0]): Promise<void> {
    try {
      await this.boss.stop(options);
    } catch (error) {
      // Shutdown must not throw: other modules still need their own hooks to run.
      this.logger.error('Failed to stop pg-boss cleanly', error instanceof Error ? error.stack : String(error));
    }
  }
}
