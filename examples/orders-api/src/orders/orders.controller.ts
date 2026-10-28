import { Body, Controller, Get, Post } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() body: { email: string; total: number; failAfterEnqueue?: boolean }) {
    return this.orders.create(body.email, body.total, body.failAfterEnqueue);
  }

  @Get()
  overview() {
    return this.orders.overview();
  }
}
