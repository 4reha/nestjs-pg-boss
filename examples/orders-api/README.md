# Orders API example

A small NestJS app that uses [nestjs-pg-boss](../../README.md). `POST /orders` saves an order and enqueues its confirmation job in the same database transaction. A worker picks the job up and sends the confirmation.

It is a plain CommonJS Nest 11 app. `nestjs-pg-boss` is ESM only, and Node 22.12 or newer loads it from `require()` without a flag.

## Run it

You need Node 22.12+ and Docker.

```bash
npm install
npm run db      # Postgres 17 in Docker on port 5432
npm start
```

Set `DATABASE_URL` to use another database. The default is `postgres://postgres:postgres@localhost:5432/postgres`.

## Try it

Create an order. The worker logs `Confirmation sent for order 1` a moment later.

```bash
curl -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"email":"a@example.com","total":42}'
```

Create one that fails after the job was enqueued. The request returns a 500, and neither the order nor the job exists afterwards, because both were part of the rolled back transaction.

```bash
curl -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"email":"b@example.com","total":7,"failAfterEnqueue":true}'
```

See what was saved. `jobs` lists the queue's jobs with their state.

```bash
curl localhost:3000/orders
```

## Where to look

| File | What it shows |
| --- | --- |
| [`src/app.module.ts`](src/app.module.ts) | `PgBossModule.forRoot`, once, in the root module. |
| [`src/orders/orders.module.ts`](src/orders/orders.module.ts) | Declaring the queue next to the code that owns it, with retry settings. |
| [`src/orders/orders.service.ts`](src/orders/orders.service.ts) | `@InjectQueue` and `queue.send(..., { db })` inside a transaction. |
| [`src/orders/order-confirmation.processor.ts`](src/orders/order-confirmation.processor.ts) | A worker as a decorated method on an ordinary provider. |
| [`src/main.ts`](src/main.ts) | `enableShutdownHooks()`, so a deploy lets running jobs finish. |

The transaction in `orders.service.ts` uses `pg` directly. Any object with an `executeSql(text, values)` method works as pg-boss's `db`. With Knex, Kysely, Drizzle or Prisma, use the `fromKnex`, `fromKysely`, `fromDrizzle` and `fromPrisma` adapters instead.

Stop the database with `docker compose down -v`.
