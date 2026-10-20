import { QUEUE_TOKEN_PREFIX } from '../pg-boss.constants.js';

/** Injection token of the `JobQueue` registered for `name`. */
export function getQueueToken(name: string): string {
  return `${QUEUE_TOKEN_PREFIX}:${name}`;
}
