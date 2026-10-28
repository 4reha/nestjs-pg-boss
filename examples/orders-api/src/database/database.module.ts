import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_URL } from '../config';

export const PG_POOL = Symbol('PG_POOL');

/** The app's own connection pool, separate from the one pg-boss manages. */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: DATABASE_URL }),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}
