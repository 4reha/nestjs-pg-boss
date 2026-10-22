import { Logger, type FactoryProvider } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { MODULE_OPTIONS_TOKEN } from './pg-boss.module-definition.js';
import { PGBOSS_INSTANCE, PGBOSS_LOGGER_CONTEXT } from './pg-boss.constants.js';
import type { PgBossModuleOptions } from './interfaces/pg-boss-module-options.interface.js';

/**
 * Builds and starts pg-boss as an async provider. Because it only resolves once `start()` has
 * finished, anything that injects the instance (queues, services) is guaranteed a ready database,
 * whatever order Nest initializes modules in.
 */
export const pgBossInstanceProvider: FactoryProvider<PgBoss> = {
  provide: PGBOSS_INSTANCE,
  inject: [MODULE_OPTIONS_TOKEN],
  useFactory: async (options: PgBossModuleOptions): Promise<PgBoss> => {
    const { start, stop, registerWorkers, ...bossOptions } = options;
    const logger = new Logger(PGBOSS_LOGGER_CONTEXT);
    const boss = new PgBoss(bossOptions);

    // pg-boss is an EventEmitter: an unhandled 'error' event would crash the process.
    boss.on('error', (error) => logger.error(error.message, error.stack));
    boss.on('warning', (warning) => logger.warn(warning.message));

    try {
      await boss.start(start);
    } catch (error) {
      await boss.stop({ close: true, graceful: false }).catch(() => undefined);
      throw error;
    }
    return boss;
  },
};
