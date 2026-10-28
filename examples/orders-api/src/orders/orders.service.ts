import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectQueue, JobQueue } from 'nestjs-pg-boss';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

export interface ConfirmationPayload {
  orderId: number;
}

@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @InjectQueue('order-confirmation') private readonly queue: JobQueue<ConfirmationPayload>,
  ) {}

  async onModuleInit() {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS orders (id serial PRIMARY KEY, email text NOT NULL, total numeric NOT NULL)',
    );
  }

  /**
   * Saves the order and enqueues its confirmation in one transaction. If anything throws before
   * COMMIT, the order and the job both disappear. `failAfterEnqueue` exists to show that.
   */
  async create(email: string, total: number, failAfterEnqueue = false) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('INSERT INTO orders (email, total) VALUES ($1, $2) RETURNING id', [
        email,
        total,
      ]);
      const orderId: number = rows[0].id;

      // Any object with executeSql(text, values) works as pg-boss's `db`.
      await this.queue.send({ orderId }, { db: { executeSql: (text, values) => client.query(text, values) } });

      if (failAfterEnqueue) throw new Error('Simulated failure after the job was enqueued');
      await client.query('COMMIT');
      return { orderId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async overview() {
    const { rows } = await this.pool.query('SELECT id, email, total FROM orders ORDER BY id');
    const jobs = await this.queue.findJobs();
    return { orders: rows, jobs: jobs.map((job) => ({ id: job.id, state: job.state, data: job.data })) };
  }
}
