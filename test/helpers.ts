import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { Module, type INestApplicationContext, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { fromPglite } from 'pg-boss';
import { afterAll, afterEach, beforeAll } from '@jest/globals';
import type { PgBossModuleOptions } from '../src/index.js';

/** Fast polling so tests don't wait out pg-boss's 2 second default. */
export const fast = { pollingIntervalSeconds: 0.5 };

export async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Collects what Nest logs, so a test can assert on warnings. */
export class CapturingLogger implements LoggerService {
  readonly warnings: string[] = [];
  log() {}
  error() {}
  debug() {}
  verbose() {}
  warn(message: unknown) {
    this.warnings.push(String(message));
  }
}

/**
 * One in-process Postgres (PGlite) per test file. Each test gets its own pg-boss schema so tests
 * never see each other's jobs, and every app a test boots is closed afterwards.
 */
export function useHarness() {
  let pglite: PGlite;
  let schemaCounter = 0;
  const apps: INestApplicationContext[] = [];

  beforeAll(() => {
    pglite = new PGlite();
  });

  afterAll(async () => {
    await pglite.close();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  return {
    get pglite() {
      return pglite;
    },

    options(overrides: Partial<PgBossModuleOptions> = {}): PgBossModuleOptions {
      return { db: fromPglite(pglite), schema: `boss_${++schemaCounter}`, ...overrides };
    },

    /** Stop tracking an app the test already closed itself, so the cleanup hook doesn't close it twice. */
    release(app: INestApplicationContext): void {
      const index = apps.indexOf(app);
      if (index >= 0) apps.splice(index, 1);
    },

    async boot(imports: any[], logger: LoggerService | false = false): Promise<INestApplicationContext> {
      @Module({ imports })
      class AppModule {}
      // abortOnError: false makes a failed bootstrap reject instead of calling process.abort().
      const app = await NestFactory.createApplicationContext(AppModule, { logger, abortOnError: false });
      apps.push(app);
      return app;
    },
  };
}
