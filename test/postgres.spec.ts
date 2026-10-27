import 'reflect-metadata';
import { Injectable, Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InjectQueue,
  JobQueue,
  PgBossModule,
  PgBossService,
  Process,
  Processor,
  type Db,
  type Job,
  type PgBossModuleOptions,
} from '../src/index.js';
import { waitFor } from './helpers.js';

/**
 * These run against a real Postgres, which PGlite cannot stand in for: the connection pool,
 * LISTEN/NOTIFY and transactional workers. They are skipped unless PG_TEST_URL points at a
 * throwaway database, e.g. postgres://postgres:postgres@localhost:5432/postgres
 */
const url = process.env.PG_TEST_URL;

const apps: INestApplicationContext[] = [];
let counter = 0;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function options(overrides: Partial<PgBossModuleOptions> = {}): PgBossModuleOptions {
  // A fresh schema per test keeps tests apart. They are left behind, so use a disposable database.
  return { connectionString: url, schema: `nestjs_pg_boss_${process.pid}_${++counter}`, ...overrides };
}

async function boot(...imports: any[]): Promise<INestApplicationContext> {
  @Module({ imports })
  class AppModule {}
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  apps.push(app);
  return app;
}

describe.skipIf(!url)('against a real Postgres', () => {
  it('processes a job through the built-in connection pool', async () => {
    const received: string[] = [];

    @Processor('pooled')
    @Injectable()
    class Pooled {
      @Process(undefined, { pollingIntervalSeconds: 0.5 })
      async run(job: Job<{ n: number }>) {
        received.push(String(job.data.n));
      }
    }

    @Module({ imports: [PgBossModule.registerQueue('pooled')], providers: [Pooled] })
    class FeatureModule {}

    const app = await boot(PgBossModule.forRoot(options()), FeatureModule);
    await app.get<JobQueue<{ n: number }>>('PgBossQueue:pooled').send({ n: 7 });

    await waitFor(() => (received.length > 0 ? true : undefined));
    expect(received).toEqual(['7']);
    expect(await app.get(PgBossService).isHealthy()).toBe(true);
  });

  it('wakes a worker through LISTEN/NOTIFY instead of waiting for the next poll', async () => {
    const received: string[] = [];

    @Processor('notified')
    @Injectable()
    class Notified {
      // Both intervals are 30 seconds, so a job arriving within a few seconds can only be a notification.
      @Process(undefined, { pollingIntervalSeconds: 30, notifyPollingIntervalSeconds: 30 })
      async run(job: Job) {
        received.push(job.id);
      }
    }

    @Module({
      imports: [PgBossModule.registerQueue({ name: 'notified', notify: true })],
      providers: [Notified],
    })
    class FeatureModule {}

    const app = await boot(PgBossModule.forRoot(options({ useListenNotify: true })), FeatureModule);
    // Give the worker a moment to finish its first, empty poll before the job arrives.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const id = await app.get<JobQueue>('PgBossQueue:notified').send({});

    await waitFor(() => (received.length > 0 ? received[0] : undefined), 8_000);
    expect(received[0]).toBe(id);
  });

  describe('transactional workers', () => {
    const table = (schema: string) => `${schema}.audit`;

    it('commits what the handler wrote through tx together with the job', async () => {
      const opts = options();

      @Processor('tx-ok')
      @Injectable()
      class Writes {
        @Process(undefined, { transactional: true, pollingIntervalSeconds: 0.5 })
        async run(job: Job<{ id: string }>, tx: Db) {
          await tx.executeSql(`INSERT INTO ${table(opts.schema!)} (id) VALUES ($1)`, [job.data.id]);
        }
      }

      @Injectable()
      class Setup {
        constructor(@InjectQueue('tx-ok') readonly queue: JobQueue<{ id: string }>) {}
      }

      @Module({ imports: [PgBossModule.registerQueue('tx-ok')], providers: [Writes, Setup] })
      class FeatureModule {}

      const app = await boot(PgBossModule.forRoot(opts), FeatureModule);
      const db = app.get(PgBossService).boss.getDb();
      await db.executeSql(`CREATE TABLE ${table(opts.schema!)} (id text)`);

      await app.get(Setup).queue.send({ id: 'kept' });
      await waitFor(async () => {
        const jobs = await app.get(Setup).queue.findJobs();
        return jobs.some((job) => job.state === 'completed') ? true : undefined;
      });

      const { rows } = await db.executeSql(`SELECT count(*)::int AS n FROM ${table(opts.schema!)} WHERE id = $1`, ['kept']);
      expect(rows[0].n).toBe(1);
    });

    it('rolls back what the handler wrote when it throws', async () => {
      const opts = options();

      @Processor('tx-fail')
      @Injectable()
      class Fails {
        @Process(undefined, { transactional: true, pollingIntervalSeconds: 0.5 })
        async run(job: Job<{ id: string }>, tx: Db) {
          await tx.executeSql(`INSERT INTO ${table(opts.schema!)} (id) VALUES ($1)`, [job.data.id]);
          throw new Error('after the write');
        }
      }

      @Injectable()
      class Setup {
        constructor(@InjectQueue('tx-fail') readonly queue: JobQueue<{ id: string }>) {}
      }

      @Module({
        imports: [PgBossModule.registerQueue({ name: 'tx-fail', retryLimit: 0 })],
        providers: [Fails, Setup],
      })
      class FeatureModule {}

      const app = await boot(PgBossModule.forRoot(opts), FeatureModule);
      const db = app.get(PgBossService).boss.getDb();
      await db.executeSql(`CREATE TABLE ${table(opts.schema!)} (id text)`);

      await app.get(Setup).queue.send({ id: 'discarded' });
      await waitFor(async () => {
        const jobs = await app.get(Setup).queue.findJobs();
        return jobs.some((job) => job.state === 'failed') ? true : undefined;
      });

      const { rows } = await db.executeSql(`SELECT count(*)::int AS n FROM ${table(opts.schema!)} WHERE id = $1`, ['discarded']);
      expect(rows[0].n).toBe(0);
    });
  });
});
