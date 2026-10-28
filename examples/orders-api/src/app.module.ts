import { Module } from '@nestjs/common';
import { PgBossModule } from 'nestjs-pg-boss';
import { DATABASE_URL } from './config';
import { DatabaseModule } from './database/database.module';
import { OrdersModule } from './orders/orders.module';

@Module({
  imports: [
    // Global: feature modules don't import it again.
    PgBossModule.forRoot({ connectionString: DATABASE_URL }),
    DatabaseModule,
    OrdersModule,
  ],
})
export class AppModule {}
