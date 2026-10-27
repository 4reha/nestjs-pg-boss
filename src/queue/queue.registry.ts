import { Inject, Injectable } from '@nestjs/common';
import type { PgBoss, UpdateQueueOptions } from 'pg-boss';
import { PGBOSS_INSTANCE } from '../pg-boss.constants.js';
import type { QueueDefinition } from '../interfaces/queue-definition.interface.js';

/**
 * Knows every queue declared through `PgBossModule.registerQueue()` and makes sure each one
 * exists in the database exactly once per process before anything uses it.
 */
@Injectable()
export class QueueRegistry {
  private readonly definitions = new Map<string, QueueDefinition>();
  private readonly ready = new Map<string, Promise<void>>();

  constructor(@Inject(PGBOSS_INSTANCE) private readonly boss: PgBoss) {}

  declare(definition: QueueDefinition): void {
    const existing = this.definitions.get(definition.name);
    if (existing && !isSameDefinition(existing, definition)) {
      throw new Error(
        `Queue "${definition.name}" is registered twice with different options. ` +
          'Register it once, or register it with identical options everywhere.',
      );
    }
    this.definitions.set(definition.name, definition);
    // A queue may have been created with defaults earlier (as another queue's dead letter queue)
    // before its own declaration showed up. Forget that so the next ensure() reconciles it.
    this.ready.delete(definition.name);
  }

  /** True when `registerQueue()` declared this queue, as opposed to it being created implicitly. */
  isDeclared(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Resolves once the queue, and its dead letter queue if any, exist and match the declaration. */
  ensure(name: string): Promise<void> {
    let pending = this.ready.get(name);
    if (!pending) {
      pending = this.create(name).catch((error: unknown) => {
        this.ready.delete(name);
        throw error;
      });
      this.ready.set(name, pending);
    }
    return pending;
  }

  private async create(name: string): Promise<void> {
    const { name: _name, ...options } = this.definitions.get(name) ?? { name };

    // pg-boss refuses to create a queue whose dead letter queue does not exist yet.
    if (options.deadLetter) {
      await this.ensure(options.deadLetter);
    }

    if (!(await this.boss.getQueue(name))) {
      await this.boss.createQueue(name, options);
      return;
    }

    const { policy, partition, retryDelayMax, heartbeatSeconds, ...updatable } = options;
    if (Object.keys(updatable).length > 0) {
      await this.boss.updateQueue(name, updatable as UpdateQueueOptions);
    }
  }
}

/** Same options in a different key order are the same definition. */
function isSameDefinition(a: QueueDefinition, b: QueueDefinition): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
