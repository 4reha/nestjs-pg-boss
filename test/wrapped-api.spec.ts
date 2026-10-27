import { Injectable, Module } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import {
  InjectQueue,
  JobQueue,
  PgBossModule,
  PgBossService,
  Process,
  Processor,
  jobStates,
  queuePolicies,
  type Job,
} from '../src/index.js';
import { fast, useHarness, waitFor } from './helpers.js';

const harness = useHarness();

describe('manual consumption', () => {
  it('fetches, completes and fails jobs through the queue handle', async () => {
    @Injectable()
    class Holder {
      constructor(@InjectQueue('manual') readonly queue: JobQueue<{ n: number }>) {}
    }

    @Module({ imports: [PgBossModule.registerQueue({ name: 'manual', retryLimit: 0 })], providers: [Holder] })
    class FeatureModule {}

    const app = await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule]);
    const { queue } = app.get(Holder);

    await queue.send({ n: 1 });
    await queue.send({ n: 2 });
    const [first, second] = (await queue.fetch({ batchSize: 2 })) as [Job<{ n: number }>, Job<{ n: number }>];
    expect([first.data.n, second.data.n].sort()).toEqual([1, 2]);

    await queue.complete(first.id, { ok: true });
    await queue.fail(second.id, { reason: 'nope' });

    const states = (await queue.findJobs()).map((job) => job.state).sort();
    expect(states).toEqual(['completed', 'failed']);
    expect((await queue.getQueueStats()).length).toBeGreaterThan(0);
  });

  it('returns metadata when asked for it', async () => {
    @Injectable()
    class Holder {
      constructor(@InjectQueue('meta') readonly queue: JobQueue<{ n: number }>) {}
    }

    @Module({ imports: [PgBossModule.registerQueue('meta')], providers: [Holder] })
    class FeatureModule {}

    const app = await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule]);
    const { queue } = app.get(Holder);

    await queue.send({ n: 1 });
    const [job] = await queue.fetch({ includeMetadata: true });
    expect(job?.state).toBe('active');
  });
});

describe('flows', () => {
  it('runs a job only after every job it depends on has completed', async () => {
    const order: string[] = [];

    @Processor('extract')
    @Injectable()
    class Extract {
      @Process(undefined, fast)
      async run(job: Job<{ file: string }>) {
        order.push(`extract:${job.data.file}`);
      }
    }

    @Processor('load')
    @Injectable()
    class Load {
      @Process(undefined, fast)
      async run() {
        order.push('load');
      }
    }

    @Module({
      imports: [PgBossModule.registerQueue('extract', 'load')],
      providers: [Extract, Load],
    })
    class FeatureModule {}

    const app = await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule]);
    const service = app.get(PgBossService);

    const ids = await service.flow([
      { ref: 'a', name: 'extract', data: { file: 'a.csv' } },
      { ref: 'b', name: 'extract', data: { file: 'b.csv' } },
      { ref: 'load', name: 'load', data: {}, dependsOn: ['a', 'b'] },
    ]);
    expect(Object.keys(ids).sort()).toEqual(['a', 'b', 'load']);

    const parents = await app.get<JobQueue>('PgBossQueue:load').getDependencies(ids.load!);
    expect(parents).toHaveLength(2);

    await waitFor(async () => {
      await service.resolveFlow();
      return order.includes('load') ? true : undefined;
    });
    expect(order.at(-1)).toBe('load');
    expect(order.filter((entry) => entry.startsWith('extract'))).toHaveLength(2);
  });

  it('creates a queue the flow names that nobody registered', async () => {
    const app = await harness.boot([PgBossModule.forRoot(harness.options())]);
    const service = app.get(PgBossService);

    await service.flow([
      { ref: 'first', name: 'unregistered-a', data: {} },
      { ref: 'second', name: 'unregistered-b', data: {}, dependsOn: ['first'] },
    ]);

    const names = (await service.getQueues(['unregistered-a', 'unregistered-b'])).map((queue) => queue.name);
    expect(names.sort()).toEqual(['unregistered-a', 'unregistered-b']);
  });
});

describe('pub/sub', () => {
  it('delivers a published event to a subscribed queue', async () => {
    @Injectable()
    class Holder {
      constructor(@InjectQueue('listener') readonly queue: JobQueue<{ hello: string }>) {}
    }

    @Module({ imports: [PgBossModule.registerQueue('listener')], providers: [Holder] })
    class FeatureModule {}

    const app = await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule]);
    const { queue } = app.get(Holder);

    await queue.subscribe('greeting');
    await app.get(PgBossService).publish('greeting', { hello: 'world' });

    const [job] = await queue.fetch();
    expect(job?.data).toEqual({ hello: 'world' });
  });
});

describe('service inspection', () => {
  it('answers the status and schema questions', async () => {
    const app = await harness.boot([PgBossModule.forRoot(harness.options())]);
    const service = app.get(PgBossService);

    expect(await service.isInstalled()).toBe(true);
    expect(await service.schemaVersion()).toEqual(expect.any(Number));
    expect(service.previewSchedule('0 9 * * *')).not.toHaveLength(0);
    expect(typeof service.isMaintaining()).toBe('boolean');
    expect(Array.isArray(await service.getInstances())).toBe(true);
  });

  it('re-exports the constants under unambiguous names', () => {
    expect(jobStates.completed).toBe('completed');
    expect(queuePolicies.standard).toBe('standard');
  });
});
