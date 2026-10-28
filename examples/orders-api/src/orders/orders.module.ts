import { Module } from '@nestjs/common';
import { PgBossModule } from 'nestjs-pg-boss';
import { OrderConfirmationProcessor } from './order-confirmation.processor';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [
    PgBossModule.registerQueue({
      name: 'order-confirmation',
      retryLimit: 3,
      retryBackoff: true,
    }),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrderConfirmationProcessor],
})
export class OrdersModule {}
