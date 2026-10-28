# nestjs-pg-boss

[![npm](https://img.shields.io/npm/v/nestjs-pg-boss)](https://www.npmjs.com/package/nestjs-pg-boss)
[![CI](https://github.com/4reha/nestjs-pg-boss/actions/workflows/ci.yml/badge.svg)](https://github.com/4reha/nestjs-pg-boss/actions/workflows/ci.yml)
[![downloads](https://img.shields.io/npm/dm/nestjs-pg-boss)](https://www.npmjs.com/package/nestjs-pg-boss)
[![types](https://img.shields.io/npm/types/nestjs-pg-boss)](https://www.npmjs.com/package/nestjs-pg-boss)
[![node](https://img.shields.io/node/v/nestjs-pg-boss)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/nestjs-pg-boss)](LICENSE)

A NestJS module for [pg-boss](https://github.com/timgit/pg-boss), a job queue that keeps its jobs in PostgreSQL. You declare queues in your modules, write workers as decorated methods on ordinary providers, and the module starts and stops pg-boss together with your application.

Jobs live in the database you already run, so there is no Redis or broker to operate. A job can also be created inside the same database transaction as your own data, which means the job exists exactly when the data does.

```ts
// Declare the queue
@Module({
  imports: [PgBossModule.registerQueue({ name: 'email', retryLimit: 3, retryBackoff: true })],
  providers: [Mailer, EmailProcessor],
})
export class EmailModule {}

// Send a job
@Injectable()
export class Mailer {
  constructor(@InjectQueue('email') private readonly queue: JobQueue<SendEmail>) {}

  send(payload: SendEmail) {
    return this.queue.send(payload);
  }
}

// Process it
@Processor('email')
@Injectable()
export class EmailProcessor {
  constructor(private readonly transport: MailTransport) {}

  @Process()
  async send(job: Job<SendEmail>) {
    await this.transport.deliver(job.data);   // throwing fails the job and triggers a retry
  }
}
```

Install it with `npm install nestjs-pg-boss pg-boss`, or run the [example app](examples/orders-api) to see it work in about two minutes.

## Why use it

- **No broker to run.** Jobs are rows in the PostgreSQL database you already have.
- **Jobs that match your data.** Pass your transaction to `send` and the job commits or rolls back together with your own writes, so you do not need an outbox table. See [Transactions](#transactions).
- **Shaped like Nest.** Queues are declared in the module that owns them, workers are decorated methods on ordinary providers, and the module starts pg-boss and drains it on shutdown.
- **Typed.** `JobQueue<T>` types the payload, and `@Process` rejects a handler with the wrong signature at compile time.
- **All of pg-boss.** Retries, dead letter queues, throttling, cron schedules, flows and pub/sub are wrapped, so you rarely need the raw instance.
- **Nest 10, 11 and 12** on Node 22.12 or newer.

### When something else fits better

If you already run Redis and want BullMQ's tooling, such as Bull Board, `@nestjs/bullmq` is a good fit. A Postgres queue also puts its load on your database, so a very high job rate may call for a separate database or a dedicated broker.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Queues](#queues)
- [Sending jobs](#sending-jobs)
- [Processing jobs](#processing-jobs)
- [Flows](#flows)
- [Pub/sub](#pubsub)
- [Fetching jobs yourself](#fetching-jobs-yourself)
- [Scheduling](#scheduling)
- [Transactions](#transactions)
- [Lifecycle and shutdown](#lifecycle-and-shutdown)
- [Deployment](#deployment)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [API overview](#api-overview)
- [Contributing](#contributing)

## Requirements

| | Supported |
| --- | --- |
| Node.js | 22.12 or newer |
| NestJS | 10, 11 and 12 |
| pg-boss | 12 |
| Database | PostgreSQL |

The package is ESM only, because pg-boss 12 is. A CommonJS Nest application can still use it. Node 22.12 and newer can load ESM from `require()` without a flag, and that is also the reason for the Node requirement. It is pg-boss 12's own minimum.

## Installation

```bash
npm install nestjs-pg-boss pg-boss
```

`pg-boss` is a peer dependency, so you install it yourself and control its version. The package also needs `@nestjs/common`, `@nestjs/core`, `reflect-metadata` and `rxjs`, which every Nest application already has.

For local development, this starts a database:

```bash
docker run --name pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:17
```

## Getting started

### 1. Configure the module once

Import `PgBossModule` in the root module. It is global, so feature modules do not import it again.

```ts
// app.module.ts
@Module({
  imports: [
    ConfigModule.forRoot(),
    PgBossModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
        schema: 'pgboss',
      }),
    }),
    EmailModule,
  ],
})
export class AppModule {}
```

On its first start, pg-boss creates its own tables in the schema you name and migrates them when you upgrade the library. The pg-boss options `createSchema` and `migrate` control this.

### 2. Declare a queue in the module that owns it

```ts
@Module({
  imports: [PgBossModule.registerQueue('email')],
  providers: [Mailer, EmailProcessor],
})
export class EmailModule {}
```

A bare string declares a queue with pg-boss defaults. Pass an object to set retries, a dead letter queue and other options, see [Queues](#queues).

### 3. Send a job

```ts
@Injectable()
export class Mailer {
  constructor(@InjectQueue('email') private readonly queue: JobQueue<SendEmail>) {}

  async welcome(to: string) {
    return this.queue.send({ to, subject: 'Welcome' });   // the job id, or null if no job was created
  }
}
```

### 4. Process it

```ts
@Processor('email')
@Injectable()
export class EmailProcessor {
  constructor(private readonly transport: MailTransport) {}

  @Process()
  async send(job: Job<SendEmail>) {
    await this.transport.deliver(job.data);
  }
}
```

The processor is a normal provider. It can inject anything and has to be singleton scoped, which is the default.

### 5. Enable shutdown hooks

```ts
// main.ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

Without this call, a SIGTERM stops the process without giving running jobs time to finish, see [Lifecycle and shutdown](#lifecycle-and-shutdown).

### What happens at startup

1. pg-boss connects, installs or migrates its schema, and starts.
2. Every queue declared with `registerQueue` is created if it is missing, or updated to match your code if it exists.
3. Once all providers exist, the module scans for `@Processor` classes and registers a worker for each `@Process` method.
4. `queue.send(...)` inserts a job row. A worker polls, claims the job and calls your method. If the method throws, pg-boss retries the job according to the queue's retry settings.

## Configuration

`PgBossModule` is configured once, in the root module, with `forRoot` or `forRootAsync`. An application has one pg-boss instance. The module does not support several connections side by side.

```ts
PgBossModule.forRoot({ connectionString: process.env.DATABASE_URL, schema: 'pgboss' });
```

`forRootAsync` accepts `useFactory`, `useClass` and `useExisting`, like other Nest modules:

```ts
// useFactory
PgBossModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ connectionString: config.getOrThrow('DATABASE_URL'), max: 10 }),
});

// useClass: the class needs a create() method
@Injectable()
class PgBossConfig {
  constructor(private readonly config: ConfigService) {}

  create(): PgBossModuleOptions {
    return { connectionString: this.config.getOrThrow('DATABASE_URL') };
  }
}

PgBossModule.forRootAsync({ imports: [ConfigModule], useClass: PgBossConfig });
```

### Options

`PgBossModuleOptions` is everything `new PgBoss(...)` accepts, plus three options that belong to this module.

| Option | Default | What it does |
| --- | --- | --- |
| `start` | none | Passed to `boss.start()`. `{ attempts: 5 }` tries up to five times, waiting one second after the first failure and doubling the wait up to 30 seconds. Useful when the database is still booting. |
| `stop` | `{ graceful: true, timeout: 30000 }` | Controls shutdown. `timeout` is in milliseconds. `close: false` leaves the connection pool open. See [Lifecycle and shutdown](#lifecycle-and-shutdown). |
| `registerWorkers` | `true` | When `false`, `@Process` methods and `@Schedule` schedules are not registered. Use it in processes that only send jobs, see [Deployment](#deployment). |

The pg-boss options you will reach for most often:

| Option | What it does |
| --- | --- |
| `connectionString` | A Postgres connection URL. |
| `host`, `port`, `database`, `user`, `password` | The individual parts, if you prefer them to a URL. `password` may be a function that returns a string or a promise. |
| `ssl` | Passed to the `pg` driver. |
| `max` | Maximum size of pg-boss's connection pool. |
| `schema` | The schema pg-boss installs its tables in. |
| `application_name` | Shown in `pg_stat_activity`, which helps when you look for pg-boss's connections. |
| `db` | Your own database adapter instead of pg-boss's pool. Used with PGlite in [tests](#testing). |
| `useListenNotify` | Wakes workers the moment a job is created. Needs `notify: true` on the queue too, see [Deployment](#deployment). |
| `migrate`, `createSchema` | Control whether pg-boss migrates and creates its schema when it starts. |
| `openTelemetry` | Tracing and metrics settings. They cost nothing until an OpenTelemetry SDK is registered. |

Every other pg-boss option is passed through untouched. The pg-boss [constructor documentation](https://pgboss.io/api/constructor) is the full reference.

### Why the module is global

Feature modules call `PgBossModule.registerQueue(...)` to declare their queues. That call returns a small module that depends on the global core, so the core has to be available everywhere. `TypeOrmModule` uses the same arrangement. If a module calls `registerQueue` and the application never imported `forRoot` or `forRootAsync`, startup fails with a message that says so (version 0.1.2 and later). Earlier versions fail with a Nest dependency error that mentions `QueueRegistry`.

## Queues

A queue is a named list of jobs with its own retry, expiry and retention settings. You declare queues with `PgBossModule.registerQueue`, and the module creates them when the application starts.

```ts
@Module({
  imports: [
    PgBossModule.registerQueue(
      { name: 'email', retryLimit: 3, retryDelay: 10, retryBackoff: true, deadLetter: 'email-dead' },
      'email-dead',
    ),
  ],
})
export class EmailModule {}
```

`registerQueue` takes any number of arguments. Each is a queue name or an object with a `name` and options. Declare a queue in the module that owns it, usually the one that sends to it.

### Queue options

These apply to every job in the queue. A job can override the retry, expiry and retention options when it is sent.

| Option | Default | Meaning |
| --- | --- | --- |
| `retryLimit` | `2` | How many times a failed job is retried. A job is attempted `retryLimit + 1` times before it is marked failed. |
| `retryDelay` | `0` | Seconds to wait before a retry. |
| `retryBackoff` | `false` | When `true`, the delay grows with each retry, starting from `retryDelay` (1 second if you did not set it), with some jitter. |
| `retryDelayMax` | no limit | Upper bound in seconds for the backoff delay. |
| `expireInSeconds` | `900` | How long a job may stay active before pg-boss treats it as stuck and retries or fails it. Raise it for long jobs. |
| `retentionSeconds` | `1209600` (14 days) | How long a job may wait in the created or retry state before it is deleted. |
| `deleteAfterSeconds` | `604800` (7 days) | How long a completed job is kept. `0` keeps completed jobs forever. |
| `heartbeatSeconds` | off | Workers must send periodic heartbeats. A job with no heartbeat for this long is retried or failed. At least 10. |
| `deadLetter` | none | The queue that receives jobs that failed all their retries. |
| `policy` | `'standard'` | How jobs may be queued and processed, see below. Fixed when the queue is created. |
| `partition` | `false` | Give the queue its own table. Useful for a very large queue that should not slow others down. Fixed when the queue is created. |
| `warningQueueSize` | none | pg-boss emits a warning when more jobs than this are waiting. |
| `notify` | `false` | Send a Postgres `NOTIFY` when a job is created, so workers wake at once. Needs `useListenNotify` on the module. |

### Dead letter queues

When a job fails and has no retries left, pg-boss copies it into the dead letter queue, with the same retention and retry settings. The dead letter queue is an ordinary queue. You can attach a processor to it, look at its jobs with `findJobs()`, or move its jobs back with `redrive()`.

```ts
@Injectable()
export class DeadLetters {
  constructor(@InjectQueue('email-dead') private readonly dead: JobQueue<SendEmail>) {}

  retryAll() {
    return this.dead.redrive();   // moves the jobs back to the queues they failed in
  }
}
```

pg-boss refuses to create a queue whose dead letter queue does not exist yet. The module handles the order: it creates the dead letter queue first, even when you list it second or declare it in a module that loads later.

### Policies

The policy decides how many jobs of the queue may exist in each state.

| Policy | Behaviour |
| --- | --- |
| `standard` | No restriction. Supports delays, priorities and throttling. |
| `short` | Only one job may be queued, any number may be active. |
| `singleton` | Only one job may be active, any number may be queued. |
| `stately` | One queued job and one active job at a time. |
| `exclusive` | Only one job may be queued or active. |
| `key_strict_fifo` | Jobs with the same `singletonKey` run in order, one at a time. Other keys run in parallel. Every job needs a `singletonKey`. |

`short`, `singleton`, `stately` and `exclusive` can be combined with a `singletonKey` so that the restriction applies per key. A send that the policy forbids creates no job, and `send` returns `null`.

### How existing queues are updated

When the application starts, each declared queue is created if it does not exist. If it exists already, the module updates the options pg-boss allows changing, so your code stays the source of truth. A change to `retryLimit` in code takes effect on the next deploy.

Some settings are fixed at creation. `policy` and `partition` cannot be changed afterwards, and pg-boss does not allow updating `retryDelayMax` or `heartbeatSeconds` either. Changing them in code has no effect on a queue that already exists, so delete and recreate the queue if you need a different value.

### Declaring the same queue twice

It is fine to declare a queue in two modules when the options are identical, in any key order. Two declarations with different options throw at startup with a message that names the queue.

### Queues you did not declare

A `@Process` method on a queue that no `registerQueue` declares still works. The module creates that queue with pg-boss defaults. From version 0.1.2 it also logs one warning per queue, because the usual cause is a typo. A misspelled name creates a second queue that has a worker, while the queue you send to has none and its jobs wait forever.

### Injecting a queue

`@InjectQueue(name)` injects a `JobQueue<T>`, a typed handle bound to one queue. The injection token is a string built from the name, and `getQueueToken('email')` returns it. You need it to provide a fake queue in a test:

```ts
{ provide: getQueueToken('email'), useValue: fakeQueue }
```

## Sending jobs

Payloads are stored as JSON, so send plain objects. Dates become strings and class instances lose their methods.

### send

```ts
const id = await this.queue.send({ invoiceId: 'inv_1' }, { priority: 10, retryLimit: 5, expireInSeconds: 3600 });
```

It returns the job id, or `null` when pg-boss did not create a job. That happens when the queue policy forbids it, or when a throttled send falls in an occupied slot.

| Job option | Meaning |
| --- | --- |
| `id` | Use your own UUID as the job id. |
| `priority` | Higher numbers are fetched first. The default is 0. |
| `startAfter` | Do not run before this time. A `Date`, an ISO string, or a number of seconds from now. |
| `singletonKey` | A key that policies and throttling use to treat jobs as the same. |
| `singletonSeconds` | At most one job per slot of this many seconds, per `singletonKey`. |
| `singletonNextSlot` | When a job already occupies the slot, create this one for the next slot instead of dropping it. |
| `group` | `{ id, tier }`, used by the group concurrency options of workers. |
| `deadLetter` | A dead letter queue for this job, overriding the queue's. |
| `retryLimit`, `retryDelay`, `retryBackoff`, `retryDelayMax` | Override the queue's retry settings for this job. |
| `expireInSeconds`, `retentionSeconds`, `deleteAfterSeconds`, `heartbeatSeconds` | Override the queue's expiry and retention for this job. |
| `db` | Run the insert on your own connection, see [Transactions](#transactions). |

### sendAfter

```ts
await this.queue.sendAfter({ invoiceId: 'inv_1' }, 3600);                    // in an hour
await this.queue.sendAfter({ invoiceId: 'inv_1' }, new Date('2026-12-01'));  // at a date
await this.queue.sendAfter({ invoiceId: 'inv_1' }, 60, { priority: 5 });     // with options
```

### sendThrottled and sendDebounced

Both allow at most one job per time slot of `seconds`, counted per `key`.

```ts
await this.queue.sendThrottled({ userId }, 30, userId);   // a second send in the same slot is dropped and returns null
await this.queue.sendDebounced({ userId }, 30, userId);   // a colliding send is moved to the next slot instead
```

Use `sendThrottled` when the work is idempotent and extra requests can be ignored. With `sendDebounced`, changes that arrive during a busy slot are still processed afterwards.

### insert

Insert many jobs in one statement. It is much cheaper than calling `send` in a loop.

```ts
await this.queue.insert([
  { data: { invoiceId: 'inv_1' } },
  { data: { invoiceId: 'inv_2' }, priority: 5 },
  { data: { invoiceId: 'inv_3' }, startAfter: 60 },
]);
```

### Finding and managing jobs

```ts
const jobs = await this.queue.findJobs({ data: { invoiceId: 'inv_1' } });
```

`findJobs` returns jobs with their metadata: `state` (`created`, `retry`, `active`, `completed`, `cancelled` or `failed`), timestamps and retry counts. You can filter by `id`, by `key`, by a subset of the payload and by whether the job is still queued, and page with `limit` and `after`.

| Method | What it does |
| --- | --- |
| `cancel(id)` | Cancels one job or an array of jobs. |
| `retry(id)` | Puts failed jobs back in the queue. |
| `deleteJob(id)` | Deletes jobs. |
| `getInfo()` | The queue's definition plus live counts: queued, active, deferred and others. |
| `update(data, options)`, `upsert(data, options)` | Edit a job in place, targeted by `id` or `singletonKey` in the options. `upsert` inserts one new job when nothing matches. |
| `resume(id)` | Puts cancelled jobs back in the queue. |
| `previewRedrive(options)` | Counts what `redrive` would move without moving it. |
| `getQueueStats(options)`, `getBlockedKeys(options)` | Queue statistics, and the singleton keys that currently block new sends (`getBlockedKeys` only works on `key_strict_fifo` queues). |
| `getSchedule(key)` | One schedule of this queue. |
| `deleteQueuedJobs()`, `deleteStoredJobs()`, `deleteAllJobs()` | Delete waiting jobs, finished jobs, or all of them. Each returns how many. |
| `supervise(options)` | Runs maintenance for this queue now. |
| `updateQueue(options)`, `deleteQueue()` | Change or remove the queue itself. |
| `redrive(options)` | On a dead letter queue, moves its jobs back to the queues they failed in. Filter with `sourceName`, `ids`, `data` or `createdBefore`. Returns how many moved. |
| `schedule`, `unschedule`, `getSchedules` | See [Scheduling](#scheduling). |

`JobQueue` is a plain provider, so you can send from anywhere Nest can inject: a controller, an event handler, or another processor. A processor that sends a follow-up job to another queue is a common way to build a pipeline.

## Processing jobs

A worker is a method on a provider. The module finds these methods when the application boots and registers each one with pg-boss.

| Decorator | On | Purpose |
| --- | --- | --- |
| `@Processor(queue?)` | a class | Marks the provider as holding workers. `queue` is the default for its methods. |
| `@Process(queue?, options?)` | a method | Handles one job at a time. Also accepts `@Process(options)`. |
| `@ProcessBatch(queue?, options?)` | a method | Handles up to `batchSize` jobs per call. Also accepts `@ProcessBatch(options)`. |

```ts
@Processor('email')
@Injectable()
export class EmailProcessor {
  constructor(private readonly transport: MailTransport) {}

  @Process()                                    // the class's queue: 'email'
  async send(job: Job<SendEmail>) {
    await this.transport.deliver(job.data);
  }

  @Process('email-priority')                    // a different queue
  async sendUrgent(job: Job<SendEmail>) {
    await this.transport.deliver(job.data, { urgent: true });
  }

  @Process({ includeMetadata: true })           // the class's queue, options only
  async audit(job: JobWithMetadata<SendEmail>) {}

  @ProcessBatch('email-digest', { batchSize: 50 })
  async digest(jobs: Job<DigestEntry>[]) {
    await this.transport.deliverDigest(jobs.map((job) => job.data));
  }
}
```

A method needs a queue from one of two places: its own decorator, or `@Processor('...')` on the class. The class must be a singleton provider. A request scoped or transient class cannot back a long running worker, so the module skips it and logs a warning.

### What the method receives

`@Process` methods receive one job, with `id`, `name` (the queue name) and `data` (your payload), plus retry and expiry details. `@ProcessBatch` methods receive an array. Both can declare a second parameter, `tx`, which is filled in only for [transactional workers](#transactional-workers).

From version 0.1.2 the decorators check the signature when you compile. A method declared as `(jobs: Job[])` under `@Process`, or `(job: Job)` under `@ProcessBatch`, is a type error.

### Failures and retries

Throw to fail a job. Any error works. pg-boss then does one of two things:

1. If the job has retries left, it schedules another attempt after the queue's `retryDelay`, growing the delay when `retryBackoff` is on.
2. If not, it marks the job failed, and copies it to the dead letter queue when one is set.

The module logs every failure with the queue name, the job ids and the error, then rethrows so pg-boss can apply the retry policy. For a batch handler, throwing fails the whole batch.

Make handlers safe to run twice. A job can be attempted again after a crash, a timeout or a retry, so a handler that charges a card needs an idempotency key, for example.

A job that stays active longer than `expireInSeconds` (15 minutes by default) is treated as stuck and retried or failed, even if your handler is still running. For long work, raise `expireInSeconds` on the queue or on the job.

### Worker options

The second argument of `@Process` and `@ProcessBatch` takes pg-boss's work options.

| Option | Meaning |
| --- | --- |
| `batchSize` | Jobs per call. Only for `@ProcessBatch`. `@Process` always uses 1. |
| `localConcurrency` | Number of workers started for this queue in this process. Each polls and runs independently. |
| `pollingIntervalSeconds` | How often an idle worker checks for jobs. The default is 2 seconds and the minimum is 0.5. |
| `notifyPollingIntervalSeconds` | The polling interval used while `LISTEN/NOTIFY` is active for the queue. |
| `includeMetadata` | Jobs arrive with their full metadata, such as `state` and timestamps. |
| `minPriority`, `maxPriority` | Only take jobs inside a priority range, so a worker can be dedicated to urgent or to low priority work. |
| `groupConcurrency`, `localGroupConcurrency` | Limit how many jobs of one `group` run at once, across all nodes or in this process. |
| `transactional`, `transactionTimeoutSeconds` | See [Transactional workers](#transactional-workers). |
| `heartbeatRefreshSeconds` | How often a heartbeat is sent, for queues that use `heartbeatSeconds`. |

```ts
@Process('thumbnails', { localConcurrency: 4, pollingIntervalSeconds: 1 })
async resize(job: Job<{ imageId: string }>) {}
```

`perJobResults` is not available through the decorators, because it changes what a handler must return. Use `PgBossService.boss.work(...)` if you need it.

Any number of application instances can run workers for the same queue, and pg-boss hands each job to one of them. Scaling out means starting more instances.

### Startup errors

The module fails at boot for mistakes it can detect, and each message names the class and method:

- A `@Process` method with no queue anywhere.
- A `@Schedule` on a method that has no `@Process`.
- A queue declared twice with different options.

## Flows

A flow is a set of jobs with dependencies between them, created in one transaction. A job that lists `dependsOn` stays blocked until every parent has completed.

```ts
const ids = await this.pgBoss.flow([
  { ref: 'extract-a', name: 'extract', data: { file: '1.csv' } },
  { ref: 'extract-b', name: 'extract', data: { file: '2.csv' } },
  { ref: 'load', name: 'load', data: { output: 'report.csv' }, dependsOn: ['extract-a', 'extract-b'] },
]);

ids.load; // the id of the load job
```

Here `this.pgBoss` is the injected `PgBossService`. A flow needs at least two jobs. Each `ref` is a name you choose for the job within this call, and `flow` returns a map from each ref to the created job id. `flow` creates any queue it names that does not exist yet, then hands the jobs to pg-boss. It takes the same `{ db }` option as the other write methods.

A background pass releases blocked jobs once their parents are done. `flowIntervalSeconds` in the module options sets how often it runs, and `resolveFlow()` runs a pass immediately, which is handy in tests. If a parent fails or is cancelled, its dependents stay blocked until you cancel or fail them. `redrive` on a dead letter queue does not resume a flow.

`JobQueue.getDependencies(id)` lists the parents of a job, and `getDependents(id)` lists its children.

## Pub/sub

`subscribe` routes an event name to a queue. `publish` then sends one job to every queue subscribed to that event.

```ts
await this.auditQueue.subscribe('invoice.paid');
await this.pgBoss.publish('invoice.paid', { invoiceId: 'inv_1' });
```

`unsubscribe(event)` removes the route.

## Fetching jobs yourself

`@Process` suits most work. When a consumer has to decide for itself when to take jobs, `JobQueue` exposes the pull API:

```ts
const jobs = await this.queue.fetch({ batchSize: 10 });
for (const job of jobs) {
  try {
    await handle(job.data);
    await this.queue.complete(job.id, { handled: true });
  } catch (error) {
    await this.queue.fail(job.id, { message: String(error) });
  }
}
```

`fetch({ includeMetadata: true })` returns `JobWithMetadata`. `touch(id)` refreshes the heartbeat of a job you are still working on, and `offWork()` stops the workers this process registered on the queue. `id` can also be the `{ id, retryCount }` of a fetched job, which limits the call to that attempt.

## Scheduling

A schedule creates a job on a recurring basis. It is stored in Postgres, so it does not depend on which instance is running, and a fleet of instances produces one job per tick, not one per instance.

Put `@Schedule` on a method that also has `@Process`. The method is both the worker and the thing the schedule runs.

```ts
@Processor('reports')
@Injectable()
export class ReportProcessor {
  constructor(private readonly reports: ReportService) {}

  @Process()
  @Schedule('0 3 * * *', { tz: 'Europe/Paris', data: { kind: 'daily' } })
  async nightly(job: Job<{ kind: string }>) {
    await this.reports.build(job.data.kind);
  }
}
```

The first argument is a cron expression or an RFC 5545 recurrence rule, which covers patterns cron cannot express:

```ts
@Schedule('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', { tz: 'UTC' })   // the last Friday of each month, at 17:00
```

Set `tz` explicitly so the schedule does not depend on a default. To check an expression before relying on it, ask pg-boss for its next occurrences:

```ts
const next = pgBossService.boss.previewSchedule('0 3 * * *', { tz: 'Europe/Paris', count: 5 });
```

`@Schedule` takes every send option plus these:

| Option | Meaning |
| --- | --- |
| `data` | The payload of each job the schedule creates. |
| `tz` | The time zone the expression is evaluated in. |
| `key` | Distinguishes several schedules on one queue. A schedule is identified by its queue and key. |
| `missed` | What to do about occurrences that came due while nothing was running, for example during a deploy. `'skip'` (the default) creates nothing for them. `'once'` creates one job for the most recent missed occurrence. |

Every instance registers its schedules each time it starts. Registering the same schedule again updates it in place, so rolling deploys do not create duplicates.

### Removing a schedule

Deleting `@Schedule` from the code does not delete the stored schedule. It keeps firing, and the jobs land in a queue that may no longer have a worker. Remove it explicitly:

```ts
await queue.unschedule();            // the schedule without a key
await queue.unschedule('nightly');   // a schedule with key 'nightly'
```

`queue.getSchedules()` lists what is stored for the queue. Run `unschedule` from a one-off script or an admin endpoint, not on every boot.

### Several schedules on one queue

The decorator creates one schedule per method. For several schedules on one queue, such as one per tenant, create them from code. `queue.schedule(cron, data, options)` is idempotent per queue and key, so calling it on every boot is fine.

```ts
@Injectable()
export class TenantSchedules implements OnApplicationBootstrap {
  constructor(@InjectQueue('tenant-sync') private readonly queue: JobQueue<{ tenantId: string }>) {}

  async onApplicationBootstrap() {
    for (const tenant of await this.loadTenants()) {
      await this.queue.schedule('*/15 * * * *', { tenantId: tenant.id }, { key: tenant.id, tz: 'UTC' });
    }
  }
}
```

A schedule for a tenant you later delete stays in the database until you `unschedule` its key. With `registerWorkers: false`, an instance registers neither workers nor `@Schedule` schedules.

## Transactions

Because jobs are rows in Postgres, they can take part in your own database transactions. There are two directions: creating a job inside a transaction, and doing database work inside a worker's transaction.

### Enqueueing inside your transaction

The common bug with a separate queue service is a dual write. You save an order, then send a job, and one of the two fails. You end up with an order that never gets its confirmation, or a confirmation for an order that was rolled back. Passing your transaction to `send` removes the problem. The job commits or rolls back together with your data.

```ts
await this.knex.transaction(async (trx) => {
  const [order] = await trx('orders').insert(dto).returning('*');
  await this.queue.send({ orderId: order.id }, { db: fromKnex(trx) });
});
```

If anything in the callback throws, Knex rolls back and the job disappears with the order. A worker cannot see the job before the transaction commits. Without `{ db }`, `send` uses its own connection and commits at once, even if your transaction later rolls back.

The adapters come from pg-boss, and the package re-exports them:

| Your library | Adapter |
| --- | --- |
| Knex | `fromKnex(trx)` |
| Kysely | `fromKysely(trx)` |
| Drizzle | `fromDrizzle(tx)` |
| Prisma | `fromPrisma(tx)` |
| PGlite | `fromPglite(db)` |
| Bun SQL | `fromBunSql(sql)` |

```ts
await this.prisma.$transaction(async (tx) => {
  const order = await tx.order.create({ data: dto });
  await this.queue.send({ orderId: order.id }, { db: fromPrisma(tx) });
});
```

This package's tests exercise the PGlite adapter. The other adapters are pg-boss's code and are not covered by this package's tests, so check them against your own setup. Any object with an `executeSql(text, values)` method also works as `db`, which is how the [example app](examples/orders-api) uses a plain `pg` client.

Every write on `JobQueue` accepts `db`: `send`, `sendAfter`, `sendThrottled`, `sendDebounced`, `insert`, `schedule`, `unschedule`, `cancel`, `retry` and `deleteJob`.

### Transactional workers

A normal worker runs your handler, and pg-boss then marks the job complete in a separate step. If the process dies between the two, the handler's effects exist but the job runs again. A transactional worker runs the handler and the completion in one database transaction. Everything you write through `tx` commits together with the job's completion, or rolls back if the handler throws.

```ts
@Processor('orders')
@Injectable()
export class OrderProcessor {
  constructor(@InjectQueue('email') private readonly email: JobQueue<{ orderId: string }>) {}

  @Process('fulfil', { transactional: true })
  async fulfil(job: Job<{ id: string }>, tx: Db) {
    await tx.executeSql('UPDATE orders SET status = $1 WHERE id = $2', ['fulfilled', job.data.id]);
    await this.email.send({ orderId: job.data.id }, { db: tx });   // the follow-up job commits with this one
  }
}
```

`tx` is the second parameter of the method and is provided only when the worker is registered with `transactional: true`. `Db` is exported from this package as a type. Both outcomes are covered by this package's tests against a real Postgres: a handler that returns commits its write together with the job, and a handler that throws after writing leaves no row behind.

Limits to keep in mind:

- The database adapter must be able to open transactions. pg-boss's own connection pool can. The PGlite adapter cannot, so test transactional workers against a real Postgres.
- The transaction holds a connection for as long as the handler runs. Leave room in the pool, see [Deployment](#deployment).
- `transactionTimeoutSeconds` bounds how long the database gives the handler's transaction. By default it is the queue's `expireInSeconds` plus 5.
- Keep handlers short. A long transaction holds locks and delays vacuuming.
- Side effects outside the database, such as an HTTP call or an email, are not rolled back. Make them safe to repeat.

## Lifecycle and shutdown

### Startup

The module starts pg-boss inside an async provider. A provider that depends on pg-boss, such as a queue, is only created after `start()` has finished, whatever order Nest initializes modules in. Code that sends a job from `onModuleInit` therefore always finds a ready database.

If `start()` fails, the application fails to start with pg-boss's original error, after the module closes the connection pool it opened. Use `start: { attempts: 5 }` to retry when the database may still be booting.

pg-boss is an event emitter, and an `error` event with no listener crashes the Node process. The module always attaches a listener and writes to the Nest `Logger` under the context `PgBoss`. `warning` events are logged as warnings.

### Shutdown

Call `app.enableShutdownHooks()` in `main.ts`. Without it, Nest does not react to SIGTERM or SIGINT, and a stopped process does not drain its workers.

Shutdown happens in two phases, and the order matters.

| Phase | Nest hook | What happens |
| --- | --- | --- |
| 1 | `beforeApplicationShutdown` | Workers stop taking new jobs. Running handlers get up to `stop.timeout` milliseconds to finish. Everything else in your application is still running. |
| 2 | `onApplicationShutdown` | pg-boss closes its own connection pool. |

Nest runs the `beforeApplicationShutdown` hooks of all modules before any `onApplicationShutdown` hook. A running job can therefore finish its last queries on your database connection before that connection closes. Version 0.1.0 stopped everything in the second phase, and a handler that was still working could lose its connection. Version 0.1.1 fixed this.

```ts
PgBossModule.forRoot({
  connectionString: process.env.DATABASE_URL,
  stop: { graceful: true, timeout: 60_000 },
});
```

| `stop` field | Default | Meaning |
| --- | --- | --- |
| `graceful` | `true` | Wait for running handlers. With `false`, running jobs are cut off. |
| `timeout` | `30000` | Milliseconds to wait. When it passes, shutdown continues and unfinished jobs are retried later, once their expiry passes. |
| `close` | `true` | With `false`, phase 2 is skipped and the pool stays open. Use it when you share the pool and close it yourself. |

With Kubernetes, `terminationGracePeriodSeconds` should be longer than `stop.timeout`, or the container is killed before the drain ends. A 60 second grace period suits the default 30 second timeout. Shutdown never throws: if pg-boss fails to stop cleanly, the error is logged and the other modules still get their own shutdown hooks.

### Health checks

`PgBossService.isHealthy()` sends `SELECT 1` through pg-boss's connection and returns `true` when the database answers. It never throws.

```ts
@Controller('health')
export class HealthController {
  constructor(private readonly pgBoss: PgBossService) {}

  @Get('ready')
  async ready() {
    if (!(await this.pgBoss.isHealthy())) {
      throw new ServiceUnavailableException('queue database unreachable');
    }
    return { status: 'ok' };
  }
}
```

The check tells you the database is reachable. It does not tell you whether workers are keeping up. For that, watch queue depth with `queue.getInfo()`, and set `warningQueueSize` on the queue so pg-boss logs a warning when it backs up.

### The underlying instance

`PgBossService.boss` is the raw `PgBoss` object, for anything you want to call directly. Most of pg-boss's API is also wrapped, on `JobQueue` for one queue and on `PgBossService` for the rest: `flow`, `resolveFlow`, `publish`, `getQueues`, `getInstances`, `getSchedules`, `previewSchedule`, `getWipData`, `getBamStatus`, `getBamEntries`, `isInstalled`, `schemaVersion`, `detectSchemaDrift`, `getReindexCommands`, `supervise`, `deleteAllJobs`, the `isMaintaining`-style status checks, `on` and `off`, and the test spies. The same instance is available under the `PGBOSS_INSTANCE` token. Do not call `start()` or `stop()` on it yourself. The module owns those.

## Deployment

### One process or two

By default one process sends and processes jobs. For production, many teams split them: the HTTP API only sends jobs, and a separate worker deployment processes them. That lets you scale and restart each side on its own, and a slow job never competes with request handling for CPU.

Set `registerWorkers` from an environment variable so one build serves both roles:

```ts
PgBossModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connectionString: config.getOrThrow('DATABASE_URL'),
    registerWorkers: config.get('ROLE') !== 'api',
  }),
});
```

The API instance, with `ROLE=api`, creates queues and sends jobs, and registers no workers and no schedules. The worker instance does not need an HTTP server. Start it as a standalone application:

```ts
// worker.ts
const app = await NestFactory.createApplicationContext(AppModule);
app.enableShutdownHooks();
```

The application keeps running because pg-boss's timers and connections keep the event loop alive. Run as many worker instances as you need. pg-boss hands each job to exactly one of them.

### Connection pools

Every instance holds its own pg-boss pool, sized by `max`. Add up `max` across all instances and compare it with your database's connection limit, including the connections your application's own database client uses.

Transactional workers hold a connection for as long as the handler runs, so a worker with `localConcurrency: 10` needs room for ten connections in that pool. pg-boss has a warning, `transactional_pool_headroom`, for a pool that is too small for that.

### LISTEN and NOTIFY

Workers poll, which costs up to the polling interval in latency. `useListenNotify` removes most of that delay by waking workers when a job is created:

```ts
PgBossModule.forRoot({ connectionString, useListenNotify: true });
PgBossModule.registerQueue({ name: 'email', notify: true });
```

Both settings are needed. It holds one extra connection for listening and needs a session pinned connection, so it does not work through PgBouncer in transaction pooling mode. When it cannot be established, pg-boss logs a warning and continues with polling. Polling always remains active as a backstop. This package's CI tests the wake up against a real Postgres, with a polling interval of 30 seconds that a job could not otherwise beat.

### Schemas and permissions

pg-boss creates and migrates its own schema when it starts, so the database role needs permission to do that, or the schema has to exist beforehand. The `createSchema` and `migrate` options control this. Use a separate `schema` per environment when several share a database.

### Rolling deploys

Set `stop.timeout` to how long your longest job needs, and give the container platform a longer grace period. Jobs that do not finish in time are retried after their expiry, so handlers must tolerate running twice. See [Shutdown](#shutdown).

## Testing

### Integration tests with PGlite

[PGlite](https://pglite.dev) is Postgres compiled to WebAssembly and runs in the test process, so no database is needed. Pass it to the module through pg-boss's `db` option:

```ts
import { PGlite } from '@electric-sql/pglite';
import { fromPglite } from 'pg-boss';

const pglite = new PGlite();

PgBossModule.forRoot({ db: fromPglite(pglite), schema: 'test_1' });
```

A few habits keep these tests quick and independent:

- Give each test its own `schema`, so tests never see each other's jobs.
- Set `pollingIntervalSeconds: 0.5` in a worker's options. The default of 2 seconds makes every test wait.
- Pass `abortOnError: false` to `NestFactory`. By default Nest calls `process.abort()` when bootstrap fails, which kills the test runner instead of rejecting.
- Close every app you boot, in an `afterEach`.
- Wait for the effect, not for a fixed delay:

```ts
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await queue.send({ to: 'a@b.c' });
const job = await waitFor(() => received[0]);
```

This package's own tests in `test/` follow this pattern and are a good source of examples. The PGlite adapter cannot open transactions, so [transactional workers](#transactional-workers) need a real Postgres.

### Unit tests

A processor is a plain class. Call its method directly:

```ts
const processor = new EmailProcessor(fakeTransport);
await processor.send({ id: '1', name: 'email', data: { to: 'a@b.c' } } as Job<SendEmail>);
expect(fakeTransport.deliver).toHaveBeenCalledWith({ to: 'a@b.c' });
```

For a service that sends jobs, provide a fake queue under the queue's token:

```ts
const send = vi.fn().mockResolvedValue('job-1');   // jest.fn() in Jest
const moduleRef = await Test.createTestingModule({
  providers: [Mailer, { provide: getQueueToken('email'), useValue: { send } }],
}).compile();

await moduleRef.get(Mailer).welcome('a@b.c');
expect(send).toHaveBeenCalledWith({ to: 'a@b.c', subject: 'Welcome' });
```

To exercise the worker registration without a database, replace the pg-boss instance with a stand-in that records the handlers it is given, then call them:

```ts
const handlers = new Map<string, (jobs: Job[]) => Promise<unknown>>();
const fakeBoss = {
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

const moduleRef = await Test.createTestingModule({
  imports: [PgBossModule.forRoot({}), PgBossModule.registerQueue('email')],
  providers: [EmailProcessor],
})
  .overrideProvider(PGBOSS_INSTANCE)
  .useValue(fakeBoss)
  .compile();
await moduleRef.init();

await handlers.get('email')!([{ id: '1', name: 'email', data: { to: 'a@b.c' } } as Job]);
```

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

A test that boots the real `PgBossModule` has to run in a runner that handles ESM. Vitest does without any setup. Jest can too, in its experimental ESM mode: start it with `node --experimental-vm-modules`, compile with `@swc/jest` (or `ts-jest` on TypeScript 6 or older), and add a resolver for the `.js` suffixes. This package's own tests run that way, so `jest.config.cjs` and `test/jest-resolver.cjs` in the repository are a working example.

### Real Postgres

[Testcontainers](https://node.testcontainers.org/modules/postgresql/) starts a throwaway Postgres in Docker, which covers what PGlite cannot: the real connection pool, `LISTEN/NOTIFY` and transactional workers.

```ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';

const container = await new PostgreSqlContainer('postgres:17').start();
PgBossModule.forRoot({ connectionString: container.getConnectionUri(), schema: 'test_1' });
// ...
await container.stop();
```

Docker has to be running. This package's own run is `npm run test:postgres`, and CI does the same in its own job. It is a separate script so that `npm test` never needs Docker.

## Troubleshooting

### `SyntaxError: Unexpected token 'export'`

Jest cannot load an ESM only package. See [Jest](#jest) for the mock that fixes it.

### `require() of ES Module ... not supported`, or `ERR_REQUIRE_ESM`

You are on a Node version older than 22.12. Loading ESM from `require()` needs 22.12 or newer, and pg-boss 12 needs it too. Upgrade Node.

### `npm install` fails with `ERESOLVE`

A peer dependency is outside the supported range. The package supports `@nestjs/common` and `@nestjs/core` 10, 11 and 12, and `pg-boss` 12.

### `PgBossModule.registerQueue('x') needs PgBossModule.forRoot()`

No module imported `forRoot` or `forRootAsync`. Import it once, in the root module. Versions before 0.1.2 report this as a Nest dependency error that mentions `QueueRegistry`.

### Jobs are sent but never processed

Check these in order:

1. Did the queue name in `send` match the name in `@Process`? A typo creates two queues. From version 0.1.2 the module warns when a processor uses a queue that nothing declared.
2. Is the process that should run workers started with `registerWorkers` left at `true`?
3. Is the class marked with `@Processor` and listed as a provider in a module that is imported?
4. Did the job get a `startAfter` in the future, or does the queue policy hold it back?
5. Is the processor request scoped? The module skips those and logs a warning.

### `send` returns `null`

pg-boss did not create a job. The queue policy forbids it (for example, `exclusive` while a job is queued), or a throttled send fell in an occupied slot.

### A job is retried after every deploy

The process stopped without draining. Call `app.enableShutdownHooks()`, and give the platform a grace period longer than `stop.timeout`. See [Shutdown](#shutdown).

### A long job runs twice

It stayed active longer than `expireInSeconds` (15 minutes by default), so pg-boss treated it as stuck and retried it. Raise `expireInSeconds` on the queue or the job.

### `LISTEN/NOTIFY` does not wake workers

You need `useListenNotify: true` on the module and `notify: true` on the queue. It also needs a session pinned connection, so it does not work through PgBouncer in transaction pooling mode. pg-boss logs a warning when the listener cannot be established, and workers fall back to polling.

### A schedule keeps firing after I removed `@Schedule`

Schedules are stored in Postgres. Call `queue.unschedule()` once. See [Removing a schedule](#removing-a-schedule).

### A queue option change has no effect

`policy`, `partition`, `retryDelayMax` and `heartbeatSeconds` cannot be updated on an existing queue. See [How existing queues are updated](#how-existing-queues-are-updated).

### `Queue "x" is registered twice with different options`

Two `registerQueue` calls declare the same queue with different options. Make them identical, or declare the queue in one place.

### `db.beginTransaction is not a function`

The database adapter cannot open transactions. This happens with `fromPglite`. Transactional workers need pg-boss's own connection pool, so test them against a real Postgres.

### A test run dies with no error

Nest calls `process.abort()` when bootstrap fails. Pass `abortOnError: false` to `NestFactory` in tests so the failure rejects instead.

## API overview

### Module

| Export | Purpose |
| --- | --- |
| `PgBossModule.forRoot(options)` | Configure pg-boss. Global. |
| `PgBossModule.forRootAsync(options)` | The same with `useFactory`, `useClass` or `useExisting`. |
| `PgBossModule.registerQueue(...queues)` | Declare queues in a feature module. Each argument is a name or a `QueueDefinition`. |

### Decorators

| Export | Purpose |
| --- | --- |
| `InjectQueue(name)` | Inject the `JobQueue` for a queue. |
| `Processor(queue?)` | Mark a provider as holding workers. |
| `Process(queue?, options?)` / `Process(options)` | Register a method as a one-job worker. |
| `ProcessBatch(queue?, options?)` / `ProcessBatch(options)` | Register a method as a batch worker. |
| `Schedule(expression, options?)` | Run a `@Process` method on a schedule. |

### Providers and tokens

| Export | Purpose |
| --- | --- |
| `JobQueue<T>` | The typed handle on one queue, see [Sending jobs](#sending-jobs). |
| `PgBossService` | `boss` (the raw instance), `isHealthy()`, the shutdown hooks, and the cross-queue parts of pg-boss's API (flows, pub/sub, inspection, maintenance). |
| `PGBOSS_INSTANCE` | Injection token of the started `PgBoss` instance. |
| `QueueRegistry` | Creates and tracks declared queues. Rarely needed directly. |
| `getQueueToken(name)` | The injection token for a queue, for providing fakes in tests. |

### Types

| Export | Purpose |
| --- | --- |
| `PgBossModuleOptions` | Options of `forRoot`. |
| `QueueDefinition` | A queue name plus its options. |
| `ProcessOptions`, `ProcessBatchOptions` | Options of the worker decorators. |
| `ScheduleDecoratorOptions` | Options of `@Schedule`. |
| `JobRef` | An id, several ids, or a fetched job's `{ id, retryCount }`. |
| `Job`, `JobWithMetadata`, `SendOptions`, `Db`, `FlowJob` and the rest | Every type pg-boss exports is re-exported. pg-boss's `Schedule` is `JobSchedule` here, because `Schedule` is the decorator. |

### Transaction adapters

`fromKnex`, `fromKysely`, `fromDrizzle`, `fromPrisma`, `fromPglite` and `fromBunSql` are re-exported from pg-boss. See [Transactions](#transactions).

### Constants and helpers

The rest of pg-boss's runtime exports are re-exported too: `scheduleKinds`, `scheduleMissedPolicies`, `previewScheduleMaxCount`, `addBins`, `percentile`, `getConstructionPlans`, `getMigrationPlans`, `getIndexBloatPlans`, `getRollbackPlans`, `getUninstallPlans`, `systemClock`, `TestClock`, `enableClockOverride`, `disableClockOverride` and `CLOCK_OVERRIDE_SETTING`. Three generic names are renamed: pg-boss's `states` is `jobStates`, `policies` is `queuePolicies` and `events` is `pgBossEvents`.

## Contributing

```bash
npm ci
npm run typecheck
npm test              # Jest, with the integration tests on PGlite, so no database is needed
npm run test:postgres # the real-Postgres tests; needs Docker
npm run build
npm run check:package
```

CI runs the tests on Node 22 and 24 against Nest 10, 11 and 12, and runs a Postgres 17 job for the tests PGlite cannot cover. See [CONTRIBUTING.md](CONTRIBUTING.md) for the commit message format and how releases are made.

## License

MIT
