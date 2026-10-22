import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { MODULE_OPTIONS_TOKEN } from './pg-boss.module-definition.js';
import { PGBOSS_INSTANCE, PGBOSS_LOGGER_CONTEXT } from './pg-boss.constants.js';
import type { PgBossModuleOptions } from './interfaces/pg-boss-module-options.interface.js';

const DEFAULT_STOP = { graceful: true, timeout: 30_000 } as const;

/**
 * Owns shutdown of the pg-boss instance and exposes it for anything the module doesn't wrap.
 * Call `app.enableShutdownHooks()` so SIGTERM drains in-flight jobs before the process exits.
 */
@Injectable()
export class PgBossService implements OnApplicationShutdown {
  private readonly logger = new Logger(PGBOSS_LOGGER_CONTEXT);

  constructor(
    @Inject(PGBOSS_INSTANCE) readonly boss: PgBoss,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: PgBossModuleOptions,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.boss.stop({ ...DEFAULT_STOP, ...this.options.stop });
    } catch (error) {
      // Shutdown must not throw: other modules still need their own hooks to run.
      this.logger.error('Failed to stop pg-boss cleanly', error instanceof Error ? error.stack : String(error));
    }
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
}
