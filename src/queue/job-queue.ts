import type {
  CommandResponse,
  CompleteOptions,
  ConnectionOptions,
  DependencyRef,
  FetchOptions,
  Job,
  JobAttempt,
  JobInsert,
  JobWithMetadata,
  ListOptions,
  OffWorkOptions,
  PgBoss,
  QueueResult,
  QueueStats,
  QueueStatsOptions,
  RedrivePreview,
  RedrivePreviewOptions,
  Schedule,
  ScheduleOptions,
  SendOptions,
  SuperviseOptions,
  UpdateOptions,
  UpdateQueueOptions,
  UpdateResponse,
  UpsertResponse,
} from 'pg-boss';

/** A job id, several ids, or the `{ id, retryCount }` of a fetched job to settle one specific attempt. */
export type JobRef = string | string[] | JobAttempt | JobAttempt[];

/**
 * A handle on one queue, typed by the payload it carries. Obtain it with `@InjectQueue('name')`.
 *
 * Every method that writes accepts pg-boss's `db` option, so a job can be enqueued in the same
 * transaction as your own writes (see `fromKnex`, `fromKysely`, `fromDrizzle`, `fromPrisma`).
 */
export class JobQueue<TData extends object = object> {
  constructor(
    readonly name: string,
    private readonly boss: PgBoss,
  ) {}

  send(data: TData, options?: SendOptions): Promise<string | null> {
    return this.boss.send(this.name, data, options);
  }

  /** Delay the job: a `Date`, an ISO string, or a number of seconds from now. */
  sendAfter(data: TData, after: Date | string | number, options: SendOptions | null = null): Promise<string | null> {
    // pg-boss overloads sendAfter per argument type, which a union can't select; the runtime accepts all three.
    return this.boss.sendAfter(this.name, data, options, after as Date);
  }

  /**
   * At most one job per `seconds` slot (per `key`). A second send in the same slot is dropped and
   * returns `null`.
   */
  sendThrottled(data: TData, seconds: number, key?: string, options: SendOptions | null = null): Promise<string | null> {
    return this.boss.sendThrottled(this.name, data, options, seconds, key);
  }

  /**
   * Like `sendThrottled`, except a send that collides with a job in the current slot is moved to the
   * next slot instead of being dropped.
   */
  sendDebounced(data: TData, seconds: number, key?: string, options: SendOptions | null = null): Promise<string | null> {
    return this.boss.sendDebounced(this.name, data, options, seconds, key);
  }

  /** Bulk insert. Cheaper than calling `send` in a loop. */
  insert(jobs: JobInsert<TData>[], options?: ConnectionOptions): Promise<string[] | null> {
    return this.boss.insert(this.name, jobs, options);
  }

  /** Create or update a recurring job. Idempotent per `(queue, key)`, so calling it on every boot is safe. */
  schedule(cron: string, data?: TData | null, options?: ScheduleOptions): Promise<void> {
    return this.boss.schedule(this.name, cron, data, options);
  }

  unschedule(key?: string, options?: ConnectionOptions): Promise<void> {
    return this.boss.unschedule(this.name, key, options);
  }

  getSchedules(key?: string): Promise<Schedule[]> {
    return this.boss.getSchedules(this.name, key);
  }

  findJobs(options?: Parameters<PgBoss['findJobs']>[1]): Promise<JobWithMetadata<TData>[]> {
    return this.boss.findJobs<TData>(this.name, options);
  }

  cancel(id: JobRef, options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.cancel(this.name, id, options);
  }

  retry(id: string | string[], options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.retry(this.name, id, options);
  }

  deleteJob(id: JobRef, options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.deleteJob(this.name, id, options);
  }

  /**
   * Call on a dead letter queue's handle: moves its jobs back to the queues they failed in.
   * Filter with `sourceName`, `ids`, `data` or `createdBefore`. Returns how many moved.
   */
  redrive(options?: Parameters<PgBoss['redrive']>[1]): Promise<number> {
    return this.boss.redrive(this.name, options);
  }

  /** Queue definition plus live counts (queued, active, deferred, ...). */
  getInfo(): Promise<QueueResult | null> {
    return this.boss.getQueue(this.name);
  }

  // Manual consumption. Use these when a `@Process` worker is the wrong shape, for example a
  // pull-based consumer that decides for itself when to take work.

  /** Take up to `batchSize` jobs off the queue. Settle each one with `complete` or `fail`. */
  fetch(options: FetchOptions & { includeMetadata: true }): Promise<JobWithMetadata<TData>[]>;
  fetch(options?: FetchOptions): Promise<Job<TData>[]>;
  fetch(options?: FetchOptions): Promise<Job<TData>[]> {
    return this.boss.fetch<TData>(this.name, options);
  }

  /** Mark fetched jobs as done. `data` is stored as the job's output. */
  complete(id: JobRef, data?: object | null, options?: CompleteOptions): Promise<CommandResponse> {
    return this.boss.complete(this.name, id, data, options);
  }

  /** Mark fetched jobs as failed. pg-boss retries them according to the queue's retry settings. */
  fail(id: JobRef, data?: object | null, options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.fail(this.name, id, data, options);
  }

  /** Refresh the heartbeat of jobs a long-running consumer still holds, so they are not treated as stalled. */
  touch(id: JobRef, options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.touch(this.name, id, options);
  }

  /** Stop the workers registered on this queue by this process. */
  offWork(options?: OffWorkOptions): Promise<void> {
    return this.boss.offWork(this.name, options);
  }

  // Changing and inspecting jobs.

  /** Edit a job in place. Pass the target as `id` or `singletonKey` in `options`; `data: null` clears the payload. */
  update(data: TData | null | undefined, options?: UpdateOptions): Promise<UpdateResponse> {
    return this.boss.update(this.name, data, options);
  }

  /** Like `update`, except that it inserts one new job when nothing matches. */
  upsert(data: TData | null | undefined, options?: UpdateOptions): Promise<UpsertResponse> {
    return this.boss.upsert(this.name, data, options);
  }

  /** Put cancelled jobs back in the queue. */
  resume(id: string | string[], options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.resume(this.name, id, options);
  }

  /** Counts what `redrive` would move, without moving anything. */
  previewRedrive(options?: RedrivePreviewOptions): Promise<RedrivePreview> {
    return this.boss.previewRedrive(this.name, options);
  }

  /** Singleton keys currently blocking new sends. Only available on `key_strict_fifo` queues; pg-boss throws on others. */
  getBlockedKeys(options?: ListOptions): Promise<string[]> {
    return this.boss.getBlockedKeys(this.name, options);
  }

  getQueueStats(options?: QueueStatsOptions): Promise<QueueStats[]> {
    return this.boss.getQueueStats(this.name, options);
  }

  // Cleanup. These delete data, so they are easy to regret in production.

  /** Delete jobs that have not run yet. Returns how many. */
  deleteQueuedJobs(): Promise<number> {
    return this.boss.deleteQueuedJobs(this.name);
  }

  /** Delete jobs that have finished (completed, failed or cancelled). Returns how many. */
  deleteStoredJobs(): Promise<number> {
    return this.boss.deleteStoredJobs(this.name);
  }

  /** Delete every job in the queue. Returns how many. */
  deleteAllJobs(): Promise<number | null> {
    return this.boss.deleteAllJobs(this.name);
  }

  /** Run maintenance (expiring, archiving, deleting) for this queue now instead of waiting for the next pass. */
  supervise(options?: SuperviseOptions): Promise<void> {
    return this.boss.supervise(this.name, options);
  }

  // The queue itself.

  /**
   * Change the queue's options in the database. `registerQueue()` already reconciles the declared
   * options on boot, so use this for changes made at runtime.
   */
  updateQueue(options: UpdateQueueOptions): Promise<void> {
    return this.boss.updateQueue(this.name, options);
  }

  /** Delete the queue and its jobs. The handle is unusable afterwards. */
  deleteQueue(): Promise<void> {
    return this.boss.deleteQueue(this.name);
  }

  // Schedules, flows and pub/sub.

  getSchedule(key?: string): Promise<Schedule | null> {
    return this.boss.getSchedule(this.name, key);
  }

  /** Jobs this job is waiting on in a flow. */
  getDependencies(id: string, options?: ConnectionOptions & ListOptions<DependencyRef>): Promise<DependencyRef[]> {
    return this.boss.getDependencies(this.name, id, options);
  }

  /** Jobs that are waiting on this job in a flow. */
  getDependents(id: string, options?: ConnectionOptions & ListOptions<DependencyRef>): Promise<DependencyRef[]> {
    return this.boss.getDependents(this.name, id, options);
  }

  /** Deliver every `PgBossService.publish(event)` to this queue. */
  subscribe(event: string): Promise<void> {
    return this.boss.subscribe(event, this.name);
  }

  unsubscribe(event: string): Promise<void> {
    return this.boss.unsubscribe(event, this.name);
  }
}
