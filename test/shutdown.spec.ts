import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { InjectQueue, JobQueue, PgBossModule, Process, Processor, type Job } from '../src/index.js';
import { fast, useHarness, waitFor } from './helpers.js';

const harness = useHarness();

describe('shutdown', () => {
  it('lets a running job finish before any other module shuts down', async () => {
    const order: string[] = [];
    let started = false;

    @Processor('slow')
    @Injectable()
    class SlowProcessor {
      @Process(undefined, fast)
      async run(_job: Job) {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // A real handler would still be talking to its database here.
        order.push('job finished');
      }
    }

    // Stands in for TypeORM or any module that closes a resource when the app shuts down.
    @Injectable()
    class Database implements OnApplicationShutdown {
      onApplicationShutdown() {
        order.push('database closed');
      }
    }

    @Module({
      imports: [PgBossModule.registerQueue('slow')],
      providers: [SlowProcessor, Database],
    })
    class FeatureModule {}

    const app = await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule]);
    await app.get<JobQueue>('PgBossQueue:slow').send({});
    await waitFor(() => (started ? true : undefined));

    await app.close();
    harness.release(app);

    expect(order).toEqual(['job finished', 'database closed']);
  });

  it('rejects the bootstrap with the underlying error when pg-boss cannot start', async () => {
    const brokenDb = {
      executeSql: async () => {
        throw new Error('database is down');
      },
    };

    await expect(
      harness.boot([PgBossModule.forRoot(harness.options({ db: brokenDb })), PgBossModule.registerQueue('never')]),
    ).rejects.toThrow(/database is down/);
  });

  it('does not close the pool when stop.close is false', async () => {
    const app = await harness.boot([
      PgBossModule.forRoot(harness.options({ stop: { close: false, timeout: 2000 } })),
      PgBossModule.registerQueue('shared-pool'),
    ]);
    const queue = app.get<JobQueue>('PgBossQueue:shared-pool');

    await app.close();
    harness.release(app);

    // The pool belongs to the caller here, so it must still answer after the app is gone.
    await expect(harness.pglite.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    expect(queue.name).toBe('shared-pool');
  });
});
