import {
  Inject,
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { PgBoss } from 'pg-boss';
import { MODULE_OPTIONS_TOKEN } from './pg-boss.module-definition.js';
import { PGBOSS_INSTANCE, PGBOSS_LOGGER_CONTEXT } from './pg-boss.constants.js';
import type { PgBossModuleOptions } from './interfaces/pg-boss-module-options.interface.js';

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

  private async stop(options: Parameters<PgBoss['stop']>[0]): Promise<void> {
    try {
      await this.boss.stop(options);
    } catch (error) {
      // Shutdown must not throw: other modules still need their own hooks to run.
      this.logger.error('Failed to stop pg-boss cleanly', error instanceof Error ? error.stack : String(error));
    }
  }
}
