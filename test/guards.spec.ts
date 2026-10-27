import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, jest } from '@jest/globals';
import {
  PGBOSS_INSTANCE,
  PgBossModule,
  Process,
  ProcessBatch,
  Processor,
  type Job,
} from '../src/index.js';
import { CapturingLogger, fast, useHarness } from './helpers.js';

const harness = useHarness();

describe('registerQueue', () => {
  it('explains what is missing when forRoot was never imported', async () => {
    await expect(harness.boot([PgBossModule.registerQueue('orphan')])).rejects.toThrow(
      /registerQueue\('orphan'\) needs PgBossModule\.forRoot\(\)/,
    );
  });

  it('accepts the same options written in a different key order', async () => {
    const app = await harness.boot([
      PgBossModule.forRoot(harness.options()),
      PgBossModule.registerQueue({ name: 'twice', retryLimit: 3, retryDelay: 5 }),
      PgBossModule.registerQueue({ retryDelay: 5, retryLimit: 3, name: 'twice' }),
    ]);
    expect(app.get('PgBossQueue:twice')).toBeDefined();
  });

  it('still rejects genuinely different options', async () => {
    await expect(
      harness.boot([
        PgBossModule.forRoot(harness.options()),
        PgBossModule.registerQueue({ name: 'differs', retryLimit: 3 }),
        PgBossModule.registerQueue({ name: 'differs', retryLimit: 4 }),
      ]),
    ).rejects.toThrow(/registered twice/);
  });
});

describe('processors', () => {
  it('warns when a processor uses a queue that registerQueue never declared', async () => {
    @Processor('typo-queue')
    @Injectable()
    class Typo {
      @Process(undefined, fast)
      async run() {}
    }

    @Module({ providers: [Typo] })
    class FeatureModule {}

    const logger = new CapturingLogger();
    await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule], logger);

    expect(logger.warnings.some((line) => line.includes('"typo-queue"') && line.includes('no registerQueue()'))).toBe(true);
  });

  it('stays quiet for a declared queue', async () => {
    @Processor('declared-queue')
    @Injectable()
    class Declared {
      @Process(undefined, fast)
      async run() {}
    }

    @Module({ imports: [PgBossModule.registerQueue('declared-queue')], providers: [Declared] })
    class FeatureModule {}

    const logger = new CapturingLogger();
    await harness.boot([PgBossModule.forRoot(harness.options()), FeatureModule], logger);

    expect(logger.warnings).toEqual([]);
  });
});

describe('handler dispatch', () => {
  /** A stand-in for pg-boss that records the handlers the explorer registers, so we can call them directly. */
  function fakeBoss() {
    const handlers = new Map<string, (jobs: Job[]) => Promise<unknown>>();
    const boss = {
      getQueue: async () => null,
      createQueue: async () => {},
      updateQueue: async () => {},
      schedule: async () => {},
      stop: async () => {},
      on: () => {},
      work: async (queue: string, _options: unknown, handler: (jobs: Job[]) => Promise<unknown>) => {
        handlers.set(queue, handler);
        return 'worker-id';
      },
    };
    return { boss, handlers };
  }

  const job = (id: string): Job => ({ id, name: 'q', data: {} }) as Job;

  it('rejects instead of dropping jobs when a single-job handler is handed several', async () => {
    const seen = jest.fn();

    @Processor('single')
    @Injectable()
    class Single {
      @Process()
      async run(received: Job) {
        seen(received.id);
      }
    }

    const { boss, handlers } = fakeBoss();
    const moduleRef = await Test.createTestingModule({
      imports: [PgBossModule.forRoot({}), PgBossModule.registerQueue('single')],
      providers: [Single],
    })
      .overrideProvider(PGBOSS_INSTANCE)
      .useValue(boss)
      .compile();
    await moduleRef.init();

    await expect(handlers.get('single')!([job('a'), job('b')])).rejects.toThrow(/Expected one job for "single"/);
    expect(seen).not.toHaveBeenCalled();

    await handlers.get('single')!([job('c')]);
    expect(seen).toHaveBeenCalledWith('c');
    await moduleRef.close();
  });

  it('hands the whole array to a batch handler', async () => {
    const seen = jest.fn();

    @Processor('many')
    @Injectable()
    class Many {
      @ProcessBatch(undefined, { batchSize: 10 })
      async run(received: Job[]) {
        seen(received.map((item) => item.id));
      }
    }

    const { boss, handlers } = fakeBoss();
    const moduleRef = await Test.createTestingModule({
      imports: [PgBossModule.forRoot({}), PgBossModule.registerQueue('many')],
      providers: [Many],
    })
      .overrideProvider(PGBOSS_INSTANCE)
      .useValue(boss)
      .compile();
    await moduleRef.init();

    await handlers.get('many')!([job('a'), job('b')]);
    expect(seen).toHaveBeenCalledWith(['a', 'b']);
    await moduleRef.close();
  });
});

describe('decorator argument forms', () => {
  it('accepts a queue, options, both or neither', async () => {
    const calls: Array<{ queue: string; options: Record<string, unknown> }> = [];
    const boss = {
      getQueue: async () => null,
      createQueue: async () => {},
      updateQueue: async () => {},
      stop: async () => {},
      on: () => {},
      work: async (queue: string, options: Record<string, unknown>) => {
        calls.push({ queue, options });
        return 'worker-id';
      },
    };

    @Processor('default-q')
    @Injectable()
    class Forms {
      @Process()
      async bare() {}

      @Process('named')
      async named() {}

      @Process({ includeMetadata: true })
      async optionsOnly() {}

      @Process('both', { includeMetadata: true })
      async both() {}

      @ProcessBatch({ batchSize: 5 })
      async batchOptionsOnly() {}
    }

    const moduleRef = await Test.createTestingModule({
      imports: [PgBossModule.forRoot({})],
      providers: [Forms],
    })
      .overrideProvider(PGBOSS_INSTANCE)
      .useValue(boss)
      .compile();
    await moduleRef.init();

    const by = (queue: string, key: string) => calls.filter((c) => c.queue === queue && key in c.options);
    expect(calls.map((c) => c.queue).sort()).toEqual(['both', 'default-q', 'default-q', 'default-q', 'named']);
    expect(by('both', 'includeMetadata')).toHaveLength(1);
    expect(by('default-q', 'includeMetadata')).toHaveLength(1);
    expect(by('default-q', 'batchSize').some((c) => c.options.batchSize === 5)).toBe(true);
    await moduleRef.close();
  });
});
