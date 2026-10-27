import { Injectable } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { Process, ProcessBatch, Processor, type Job } from '../src/index.js';

/**
 * These are compile-time tests: `npm run typecheck` fails if a `@ts-expect-error` line stops being
 * an error, which means the decorator stopped rejecting a wrong handler signature.
 */
describe('handler signatures', () => {
  it('accept the shapes the explorer actually calls', () => {
    @Processor('types')
    @Injectable()
    class Valid {
      @Process()
      async noArgs() {}

      @Process()
      async oneJob(_job: Job<{ id: string }>) {}

      @Process('types', { transactional: true })
      async withTransaction(_job: Job, _tx: { executeSql(sql: string): Promise<unknown> }) {}

      @ProcessBatch()
      async batch(_jobs: Job<{ id: string }>[]) {}
    }
    expect(Valid).toBeDefined();
  });

  it('reject a batch handler under @Process and the reverse', () => {
    @Injectable()
    class Invalid {
      // @ts-expect-error @Process hands over one job, not an array
      @Process()
      async wrongForSingle(_jobs: Job[]) {}

      // @ts-expect-error @ProcessBatch hands over an array, not one job
      @ProcessBatch()
      async wrongForBatch(_job: Job) {}
    }
    expect(Invalid).toBeDefined();
  });
});

describe('decorator argument forms', () => {
  it('type checks every overload', () => {
    class Forms {
      @Process() a(_job: Job) {}
      @Process('q') b(_job: Job) {}
      @Process({ includeMetadata: true }) c(_job: Job) {}
      @Process('q', { includeMetadata: true }) d(_job: Job) {}
      @Process(undefined, { includeMetadata: true }) e(_job: Job) {}
      // @ts-expect-error batchSize is fixed for @Process
      @Process({ batchSize: 3 }) f(_job: Job) {}
    }
    expect(Forms).toBeDefined();
  });
});
