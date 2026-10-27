import { DiscoveryService } from '@nestjs/core';
import type { Db, Job, ScheduleOptions, WorkOptions } from 'pg-boss';

/**
 * What a `@Process` method may look like. `tx` is only passed when the worker is registered with
 * `transactional: true`; declare it as the second parameter to receive it.
 */
export type JobHandler = (job: Job<any>, tx: Db) => unknown;

/** What a `@ProcessBatch` method may look like. */
export type BatchJobHandler = (jobs: Job<any>[], tx: Db) => unknown;

/** A method decorator that only accepts methods matching `Handler`, so a wrong signature fails to compile. */
export type MethodDecoratorFor<Handler> = <T extends Handler>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => void;

/**
 * `perJobResults` changes the handler contract (it must return a result per job), so it is not
 * exposed here. Use the `PgBossService` escape hatch if you need it.
 */
export type ProcessOptions = Omit<WorkOptions, 'batchSize' | 'perJobResults'>;
export type ProcessBatchOptions = Omit<WorkOptions, 'perJobResults'>;
export type ScheduleDecoratorOptions = ScheduleOptions & { data?: object };

export interface ProcessorMetadata {
  queue?: string;
}

export interface ProcessMetadata {
  queue?: string;
  options: WorkOptions;
  batch: boolean;
}

export interface ScheduleMetadata {
  cron: string;
  options: ScheduleDecoratorOptions;
}

export const ProcessorMarker = DiscoveryService.createDecorator<ProcessorMetadata>();
export const ProcessMarker = DiscoveryService.createDecorator<ProcessMetadata>();
export const ScheduleMarker = DiscoveryService.createDecorator<ScheduleMetadata>();

/**
 * Marks a provider as a job processor so its `@Process` / `@ProcessBatch` methods are registered
 * as pg-boss workers. `queue` is the default for methods that don't name one.
 *
 * ```ts
 * @Processor('email')
 * export class EmailProcessor {
 *   @Process()
 *   async send(job: Job<SendEmailPayload>) {}
 * }
 * ```
 */
export const Processor = (queue?: string) => ProcessorMarker({ queue });

/**
 * Handles one job at a time. The method receives the job (and, with `transactional: true`, the
 * transaction as a second argument). Throwing fails the job and lets pg-boss retry it according
 * to the queue's retry settings.
 */
export const Process = (queue?: string, options: ProcessOptions = {}): MethodDecoratorFor<JobHandler> =>
  ProcessMarker({ queue, options: { ...options, batchSize: 1 }, batch: false }) as MethodDecoratorFor<JobHandler>;

/** Handles up to `batchSize` jobs per call. The method receives an array of jobs. */
export const ProcessBatch = (queue?: string, options: ProcessBatchOptions = {}): MethodDecoratorFor<BatchJobHandler> =>
  ProcessMarker({ queue, options, batch: true }) as MethodDecoratorFor<BatchJobHandler>;

/**
 * Runs the decorated `@Process` method on a cron expression or RFC 5545 recurrence rule.
 * The schedule is stored in Postgres, so a fleet of instances produces one job per tick.
 * Pass `data` to set the job payload.
 */
export const Schedule = (cron: string, options: ScheduleDecoratorOptions = {}) =>
  ScheduleMarker({ cron, options });
