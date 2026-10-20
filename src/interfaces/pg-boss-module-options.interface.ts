import type { ConstructorOptions, PgBoss, StopOptions } from 'pg-boss';

type StartOptions = NonNullable<Parameters<PgBoss['start']>[0]>;

/**
 * Everything `new PgBoss(...)` accepts (connection, schema, maintenance, scheduling, ...),
 * plus a few options that control how the module drives its lifecycle.
 */
export interface PgBossModuleOptions extends ConstructorOptions {
  /** Passed to `boss.start()`, e.g. `{ attempts: 5 }` to ride out a database that is still booting. */
  start?: StartOptions;

  /**
   * Passed to `boss.stop()` on application shutdown.
   * @default { graceful: true, timeout: 30_000 }
   */
  stop?: StopOptions;

  /**
   * Register `@Process` workers and `@Schedule` schedules when the app boots.
   * Set to `false` in processes that only enqueue jobs (an HTTP API, for example)
   * so that a separate worker deployment does the processing.
   * @default true
   */
  registerWorkers?: boolean;
}
