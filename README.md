# nestjs-pg-boss

A NestJS module for [pg-boss](https://github.com/timgit/pg-boss) (v12). Queues are declared in code, workers are decorated methods, and the instance follows the Nest lifecycle.

Works with NestJS 10+ and pg-boss 12. Requires Node 22.12 or newer.

```bash
npm i nestjs-pg-boss pg-boss
```

The package is ESM-only, because pg-boss 12 is. A CommonJS Nest app (the default for `nest new` before v12) can still `import` from it: Node 22.12+ loads ESM from `require()` without a flag. That is also why the Node floor is 22.12, which is pg-boss 12's own minimum.

## Setup

```ts
@Module({
  imports: [
    PgBossModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connectionString: config.getOrThrow('DATABASE_URL'),
        schema: 'pgboss',
      }),
    }),
  ],
})
export class AppModule {}
```

`forRoot` takes every option `new PgBoss()` does, plus:

| Option | Default | |
| --- | --- | --- |
| `start` | | Passed to `boss.start()`, e.g. `{ attempts: 5 }`. |
| `stop` | `{ graceful: true, timeout: 30000 }` | Passed to `boss.stop()` on shutdown. |
| `registerWorkers` | `true` | Set `false` in processes that only enqueue. |

Call `app.enableShutdownHooks()` in `main.ts` so SIGTERM lets running jobs finish.

## Declare a queue and enqueue

```ts
@Module({
  imports: [PgBossModule.registerQueue({ name: 'email', retryLimit: 3, retryBackoff: true, deadLetter: 'email-dead' }, 'email-dead')],
  providers: [Mailer, EmailProcessor],
})
export class EmailModule {}

@Injectable()
export class Mailer {
  constructor(@InjectQueue('email') private readonly queue: JobQueue<SendEmail>) {}

  send(payload: SendEmail) {
    return this.queue.send(payload);
  }
}
```

The queue is created on boot. If it already exists, the options pg-boss lets you change are updated to match the code. `policy` and `partition` are fixed at creation.

## Process jobs

```ts
@Processor('email')
@Injectable()
export class EmailProcessor {
  constructor(private readonly mailer: MailService) {}

  @Process()
  async send(job: Job<SendEmail>) {
    await this.mailer.deliver(job.data);   // throwing fails the job and triggers a retry
  }

  @ProcessBatch('email-digest', { batchSize: 50 })
  async digest(jobs: Job<Digest>[]) {}

  @Process('reports')
  @Schedule('0 3 * * *', { tz: 'Europe/Paris', data: { kind: 'daily' } })
  async nightly(job: Job<{ kind: string }>) {}
}
```

Processors are normal providers, so they can inject anything. They must be singleton-scoped.

### Handler arguments

`@Process` methods receive one job. `@ProcessBatch` methods receive an array of up to `batchSize` jobs. The decorators check the method signature at compile time, so a `(jobs: Job[])` method under `@Process` does not compile.

A method can declare a second parameter, `tx`. pg-boss passes it only to workers registered with `transactional: true`. In that mode the handler and the job's completion run in one database transaction, and anything written through `tx` commits together with it:

```ts
@Process('orders', { transactional: true })
async fulfil(job: Job<Order>, tx: Db) {
  await tx.executeSql('UPDATE orders SET status = $1 WHERE id = $2', ['fulfilled', job.data.id]);
}
```

This needs a pg-boss database that can open transactions. The built-in connection pool can. The PGlite adapter cannot.

### Schedules

A schedule is stored in Postgres under its queue name and key. Every instance registers it on boot, which is safe because registering is idempotent. Removing `@Schedule` from the code does not remove the stored schedule, so it keeps firing. Remove it with `queue.unschedule()`, or `queue.unschedule('key')` if you set a `key`. `queue.getSchedules()` lists what is stored.

## Enqueue inside your own transaction

Every write method on `JobQueue` accepts pg-boss's `db` option. Wrap your ORM's transaction with the matching adapter and the job commits or rolls back with your data:

```ts
await this.knex.transaction(async (trx) => {
  const [order] = await trx('orders').insert(dto).returning('*');
  await this.queue.send({ orderId: order.id }, { db: fromKnex(trx) });   // or fromKysely / fromDrizzle / fromPrisma
});
```

## Escape hatch

`PgBossService.boss` is the raw `PgBoss` instance. `PgBossService.isHealthy()` is a database ping for readiness probes.

## Behaviour worth knowing

- pg-boss starts inside an async provider, so anything that injects a queue gets a ready database regardless of module init order.
- The `error` and `warning` events are routed to the Nest `Logger`. An unhandled `error` event would otherwise crash the process.
- A processor method that throws is logged with the queue name and job id, then rethrown so pg-boss applies the retry policy.
- A queue named by `@Process` but not declared with `registerQueue` is created with pg-boss defaults, and a warning is logged once. A typo in the name would otherwise leave the real queue with no worker.
- Dead letter queues are created before the queues that point at them.
- Declaring the same queue twice is fine when the options match, in any key order. Different options throw at startup.

## Shutdown

Call `app.enableShutdownHooks()`. On SIGTERM the workers stop and running jobs get up to 30 seconds (`stop.timeout`) to finish, while the rest of the application, such as your database connection, is still up. pg-boss then closes its own pool. Set `stop: { close: false }` if you share the pool and close it yourself.

## Testing

Vitest works without any setup. For integration tests, point the module at an in-process Postgres so no database is needed:

```ts
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from 'pg-boss';

PgBossModule.forRoot({ db: fromPglite(new PGlite()), schema: 'test' });
```

Set `pollingIntervalSeconds: 0.5` in a worker's options to keep tests fast. The default is 2 seconds.

### Jest

This package and pg-boss 12 are both ESM only. Jest runs a CommonJS module system, so importing either one fails with `SyntaxError: Unexpected token 'export'`, even in a unit test that only needs `@InjectQueue`. Transforming them with `transformIgnorePatterns` did not work when I tried it with ts-jest 29.

Mock the package instead. A file named `__mocks__/nestjs-pg-boss.ts` next to `node_modules` is used automatically, with no `jest.mock` call in each spec:

```ts
import { Inject } from '@nestjs/common';

// Only what the code under test imports. Add more as you need it.
const noop = () => () => undefined;

export const getQueueToken = (name: string) => `PgBossQueue:${name}`;
export const InjectQueue = (name: string) => Inject(getQueueToken(name));
export const Processor = noop;
export const Process = noop;
export const ProcessBatch = noop;
export const Schedule = noop;
```

A unit test then provides a fake queue under the same token:

```ts
const send = jest.fn().mockResolvedValue('job-1');
const moduleRef = await Test.createTestingModule({
  providers: [Mailer, { provide: getQueueToken('email'), useValue: { send } }],
}).compile();
```

A test that boots the real `PgBossModule` has to run in Vitest or another runner that handles ESM.
