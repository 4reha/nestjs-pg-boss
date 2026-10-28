import { Injectable, Logger } from '@nestjs/common';
import { Job, Process, Processor } from 'nestjs-pg-boss';
import type { ConfirmationPayload } from './orders.service';

@Processor('order-confirmation')
@Injectable()
export class OrderConfirmationProcessor {
  private readonly logger = new Logger(OrderConfirmationProcessor.name);

  @Process()
  async confirm(job: Job<ConfirmationPayload>) {
    // Send the email here. Throwing fails the job, and pg-boss retries it with backoff.
    this.logger.log(`Confirmation sent for order ${job.data.orderId}`);
  }
}
