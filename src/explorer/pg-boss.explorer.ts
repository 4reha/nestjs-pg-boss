import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper.js';
import type { Job, PgBoss, Db, WorkOptions } from 'pg-boss';
import { MODULE_OPTIONS_TOKEN } from '../pg-boss.module-definition.js';
import { PGBOSS_INSTANCE, PGBOSS_LOGGER_CONTEXT } from '../pg-boss.constants.js';
import type { PgBossModuleOptions } from '../interfaces/pg-boss-module-options.interface.js';
import { QueueRegistry } from '../queue/queue.registry.js';
import { ProcessMarker, ProcessorMarker, ScheduleMarker } from '../decorators/processor.decorators.js';

/** A decorated method: receives one job or an array of jobs, depending on `@Process` vs `@ProcessBatch`. */
type ProcessorMethod = (jobs: Job<any> | Job<any>[], tx?: Db) => Promise<unknown>;

/**
 * On bootstrap, finds every `@Processor()` provider and registers its `@Process` methods as
 * pg-boss workers and its `@Schedule` methods as schedules. Runs after all providers exist, so
 * a processor can depend on anything in the application.
 */
@Injectable()
export class PgBossExplorer implements OnApplicationBootstrap {
  private readonly logger = new Logger(PGBOSS_LOGGER_CONTEXT);

  constructor(
    @Inject(PGBOSS_INSTANCE) private readonly boss: PgBoss,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PgBossModuleOptions,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(QueueRegistry) private readonly registry: QueueRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.registerWorkers === false) {
      return;
    }
    const processors = this.discovery.getProviders({ metadataKey: ProcessorMarker.KEY });
    for (const wrapper of processors) {
      await this.registerProcessor(wrapper);
    }
  }

  private async registerProcessor(wrapper: InstanceWrapper): Promise<void> {
    const { instance } = wrapper;
    const className = wrapper.metatype?.name ?? 'UnknownProcessor';
    if (!instance) {
      return;
    }
    if (!wrapper.isDependencyTreeStatic()) {
      // A worker is a long-lived singleton, so a request- or transient-scoped class can't back one.
      this.logger.warn(`${className} is not singleton-scoped, so its workers were not registered.`);
      return;
    }

    const processor = this.discovery.getMetadataByDecorator(ProcessorMarker, wrapper);
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of this.scanner.getAllMethodNames(prototype)) {
      const process = this.discovery.getMetadataByDecorator(ProcessMarker, wrapper, methodName);
      const schedule = this.discovery.getMetadataByDecorator(ScheduleMarker, wrapper, methodName);
      const where = `${className}.${methodName}`;

      if (!process) {
        if (schedule) {
          throw new Error(`${where} has @Schedule but no @Process, so there is nothing to run on the schedule.`);
        }
        continue;
      }

      const queue = process.queue ?? processor?.queue;
      if (!queue) {
        throw new Error(`${where} has no queue. Name it in @Process('queue') or in @Processor('queue').`);
      }

      await this.registry.ensure(queue);

      const method = (instance as Record<string, ProcessorMethod>)[methodName]!.bind(instance);
      await this.boss.work(queue, process.options as WorkOptions, this.createHandler(queue, method, process.batch));
      this.logger.log(`${where} is processing "${queue}"`);

      if (schedule) {
        const { data, ...scheduleOptions } = schedule.options;
        await this.boss.schedule(queue, schedule.cron, data ?? null, scheduleOptions);
        this.logger.log(`${where} is scheduled on "${schedule.cron}"`);
      }
    }
  }

  private createHandler(queue: string, method: ProcessorMethod, batch: boolean) {
    return async (jobs: Job<any>[], tx?: Db): Promise<unknown> => {
      try {
        return await method(batch ? jobs : jobs[0]!, tx);
      } catch (error) {
        const ids = jobs.map((job) => job.id).join(', ');
        const reason = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`"${queue}" job ${ids} failed: ${reason.message}`, reason.stack);
        throw error;
      }
    };
  }
}
