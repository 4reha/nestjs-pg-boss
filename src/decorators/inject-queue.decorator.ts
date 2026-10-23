import { Inject } from '@nestjs/common';
import { getQueueToken } from '../utils/get-queue-token.util.js';

/** Injects the `JobQueue` registered for `name` with `PgBossModule.registerQueue()`. */
export const InjectQueue = (name: string): ParameterDecorator & PropertyDecorator => Inject(getQueueToken(name));
