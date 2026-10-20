import type { Queue } from 'pg-boss';

/**
 * A queue declared in code. The module creates it on boot and, when it already exists,
 * reconciles the options pg-boss allows changing so the code stays the source of truth.
 * `policy` and `partition` are fixed at creation time.
 */
export type QueueDefinition = Queue;
