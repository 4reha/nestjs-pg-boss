export { PgBossModule } from './pg-boss.module.js';
export { PgBossService } from './pg-boss.service.js';
export { PGBOSS_INSTANCE } from './pg-boss.constants.js';
export { JobQueue } from './queue/job-queue.js';
export { QueueRegistry } from './queue/queue.registry.js';
export { InjectQueue } from './decorators/inject-queue.decorator.js';
export { Processor, Process, ProcessBatch, Schedule } from './decorators/processor.decorators.js';
export type {
  ProcessOptions,
  ProcessBatchOptions,
  ScheduleDecoratorOptions,
} from './decorators/processor.decorators.js';
export { getQueueToken } from './utils/get-queue-token.util.js';
export type { PgBossModuleOptions } from './interfaces/pg-boss-module-options.interface.js';
export type { QueueDefinition } from './interfaces/queue-definition.interface.js';

// Transaction adapters, so callers don't need a second import from 'pg-boss'.
export { fromKnex, fromKysely, fromDrizzle, fromPrisma } from 'pg-boss';
export type { Job, JobWithMetadata, SendOptions, Db } from 'pg-boss';
