import { Injectable, Module } from '@nestjs/common';
import { fromPglite } from 'pg-boss';
import { describe, expect, it } from 'vitest';
import {
  InjectQueue,
  JobQueue,
  PgBossModule,
  PgBossService,
  Process,
  ProcessBatch,
  Processor,
  Schedule,
  type Job,
} from '../src/index.js';
import { fast, useHarness, waitFor } from './helpers.js';

const harness = useHarness();
const options = harness.options.bind(harness);
const boot = (...imports: any[]) => harness.boot(imports);

describe('PgBossModule', () => {
  it('delivers an enqueued job to the @Process method with typed data', async () => {
    const received: Job<{ to: string }>[] = [];

    @Processor('email')
    @Injectable()
    class EmailProcessor {
      @Process(undefined, fast)
      async send(job: Job<{ to: string }>) {
        received.push(job);
      }
    }

    @Injectable()
    class Mailer {
      constructor(@InjectQueue('email') readonly queue: JobQueue<{ to: string }>) {}
    }

    @Module({ imports: [PgBossModule.registerQueue('email')], providers: [EmailProcessor, Mailer] })
    class EmailModule {}

    const app = await boot(PgBossModule.forRoot(options()), EmailModule);
    const id = await app.get(Mailer).queue.send({ to: 'a@b.c' });

    const job = await waitFor(() => received[0]);
    expect(job.id).toBe(id);
    expect(job.data).toEqual({ to: 'a@b.c' });
  });

  it('supports forRootAsync with a factory', async () => {
    const app = await boot(
      PgBossModule.forRootAsync({ useFactory: async () => options() }),
      PgBossModule.registerQueue('async-queue'),
    );
    expect(await app.get(PgBossService).isHealthy()).toBe(true);
  });

  it('hands a batch to @ProcessBatch', async () => {
    const batches: number[] = [];

    @Processor('bulk')
    @Injectable()
    class BulkProcessor {
      @ProcessBatch(undefined, { batchSize: 5, ...fast })
      async handle(jobs: Job<{ n: number }>[]) {
        batches.push(jobs.length);
      }
    }

    @Module({ imports: [PgBossModule.registerQueue('bulk')], providers: [BulkProcessor] })
    class BulkModule {}

    const app = await boot(PgBossModule.forRoot(options()), BulkModule);
    await app.get<JobQueue<{ n: number }>>('PgBossQueue:bulk').insert([{ data: { n: 1 } }, { data: { n: 2 } }, { data: { n: 3 } }]);

    await waitFor(() => (batches.reduce((a, b) => a + b, 0) === 3 ? true : undefined));
    // Three jobs were inserted at once, so at least one call must have received more than one.
    expect(Math.max(...batches)).toBeGreaterThan(1);
  });

  it('retries a failing job, then moves it to the dead letter queue', async () => {
    let attempts = 0;

    @Processor('flaky')
    @Injectable()
    class FlakyProcessor {
      @Process(undefined, fast)
      async run() {
        attempts += 1;
        throw new Error('boom');
      }
    }

    @Module({
      imports: [
        PgBossModule.registerQueue({ name: 'flaky', retryLimit: 1, retryDelay: 1, deadLetter: 'flaky-dead' }),
        PgBossModule.registerQueue('flaky-dead'),
      ],
      providers: [FlakyProcessor],
    })
    class FlakyModule {}

    const app = await boot(PgBossModule.forRoot(options()), FlakyModule);
    await app.get<JobQueue>('PgBossQueue:flaky').send({ x: 1 });

    const dead = await waitFor(async () => {
      const jobs = await app.get<JobQueue>('PgBossQueue:flaky-dead').findJobs();
      return jobs.length > 0 ? jobs : undefined;
    }, 20_000);
    expect(dead[0]?.data).toEqual({ x: 1 });
    expect(attempts).toBe(2);
  });

  it('does not register workers when registerWorkers is false', async () => {
    const handled: string[] = [];

    @Processor('producer-only')
    @Injectable()
    class Ignored {
      @Process(undefined, fast)
      async run(job: Job) {
        handled.push(job.id);
      }
    }

    @Module({ imports: [PgBossModule.registerQueue('producer-only')], providers: [Ignored] })
    class FeatureModule {}

    const app = await boot(PgBossModule.forRoot(options({ registerWorkers: false })), FeatureModule);
    await app.get<JobQueue>('PgBossQueue:producer-only').send({});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(handled).toEqual([]);
  });

  it('fails at bootstrap when @Schedule has no @Process', async () => {
    @Processor('orphan')
    @Injectable()
    class Orphan {
      @Schedule('* * * * *')
      async tick() {}
    }

    @Module({ imports: [PgBossModule.registerQueue('orphan')], providers: [Orphan] })
    class OrphanModule {}

    await expect(boot(PgBossModule.forRoot(options()), OrphanModule)).rejects.toThrow(/@Schedule but no @Process/);
  });

  it('fails at bootstrap when a method has no queue', async () => {
    @Processor()
    @Injectable()
    class NoQueue {
      @Process()
      async run() {}
    }

    await expect(boot(PgBossModule.forRoot(options()), PgBossModule.registerQueue('x'), nestModule([NoQueue]))).rejects.toThrow(
      /has no queue/,
    );
  });

  it('stores a @Schedule so the cron survives in Postgres', async () => {
    @Processor('nightly')
    @Injectable()
    class Nightly {
      @Process(undefined, fast)
      @Schedule('0 3 * * *', { tz: 'UTC', data: { kind: 'report' } })
      async run() {}
    }

    @Module({ imports: [PgBossModule.registerQueue('nightly')], providers: [Nightly] })
    class NightlyModule {}

    const app = await boot(PgBossModule.forRoot(options()), NightlyModule);
    const [schedule] = await app.get<JobQueue>('PgBossQueue:nightly').getSchedules();
    expect(schedule).toMatchObject({ name: 'nightly', cron: '0 3 * * *', timezone: 'UTC', data: { kind: 'report' } });
  });

  it('does not enqueue the job when the surrounding transaction rolls back', async () => {
    const app = await boot(PgBossModule.forRoot(options()), PgBossModule.registerQueue('tx-queue'));
    const queue = app.get<JobQueue>('PgBossQueue:tx-queue');

    // The caller's own transaction (here PGlite's, in an app it would be Knex/Prisma/...) wrapped by an adapter.
    await expect(
      harness.pglite.transaction(async (tx) => {
        await queue.send({ rolledBack: true }, { db: fromPglite(tx) });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    await harness.pglite.transaction(async (tx) => {
      await queue.send({ committed: true }, { db: fromPglite(tx) });
    });

    const jobs = await queue.findJobs();
    expect(jobs.map((job) => job.data)).toEqual([{ committed: true }]);
  });

  it('rejects the same queue declared twice with different options', async () => {
    await expect(
      boot(
        PgBossModule.forRoot(options()),
        PgBossModule.registerQueue({ name: 'dup', retryLimit: 1 }),
        PgBossModule.registerQueue({ name: 'dup', retryLimit: 5 }),
      ),
    ).rejects.toThrow(/registered twice/);
  });

  it('reconciles queue options on an existing queue', async () => {
    const opts = options();
    const first = await boot(PgBossModule.forRoot(opts), PgBossModule.registerQueue({ name: 'tuned', retryLimit: 1 }));
    await first.close();
    harness.release(first);

    const second = await boot(PgBossModule.forRoot(opts), PgBossModule.registerQueue({ name: 'tuned', retryLimit: 7 }));
    const info = await second.get<JobQueue>('PgBossQueue:tuned').getInfo();
    expect(info?.retryLimit).toBe(7);
  });
});

function nestModule(providers: any[]) {
  @Module({ providers })
  class DynamicTestModule {}
  return DynamicTestModule;
}
