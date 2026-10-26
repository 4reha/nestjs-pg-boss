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
- A queue named by `@Process` but not declared with `registerQueue` is created with pg-boss defaults.
- Dead letter queues are created before the queues that point at them.
