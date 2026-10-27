import type {
  CommandResponse,
  ConnectionOptions,
  JobInsert,
  JobWithMetadata,
  PgBoss,
  QueueResult,
  Schedule,
  ScheduleOptions,
  SendOptions,
} from 'pg-boss';

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

  cancel(id: string | string[], options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.cancel(this.name, id, options);
  }

  retry(id: string | string[], options?: ConnectionOptions): Promise<CommandResponse> {
    return this.boss.retry(this.name, id, options);
  }

  deleteJob(id: string | string[], options?: ConnectionOptions): Promise<CommandResponse> {
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
}
