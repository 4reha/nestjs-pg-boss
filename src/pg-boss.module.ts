import { Module, type DynamicModule, type FactoryProvider, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { PgBoss } from 'pg-boss';
import { ASYNC_OPTIONS_TYPE, ConfigurableModuleClass, OPTIONS_TYPE } from './pg-boss.module-definition.js';
import { PGBOSS_INSTANCE } from './pg-boss.constants.js';
import { pgBossInstanceProvider } from './pg-boss.providers.js';
import { PgBossService } from './pg-boss.service.js';
import { PgBossExplorer } from './explorer/pg-boss.explorer.js';
import { QueueRegistry } from './queue/queue.registry.js';
import { JobQueue } from './queue/job-queue.js';
import { getQueueToken } from './utils/get-queue-token.util.js';
import type { QueueDefinition } from './interfaces/queue-definition.interface.js';

const coreProviders = [pgBossInstanceProvider, QueueRegistry, PgBossService, PgBossExplorer];

/** The core is global (like `TypeOrmModule`), so feature modules only need `registerQueue`. */
function asGlobalCore(definition: DynamicModule): DynamicModule {
  return {
    ...definition,
    global: true,
    imports: [...(definition.imports ?? []), DiscoveryModule],
    providers: [...(definition.providers ?? []), ...coreProviders],
    exports: [PGBOSS_INSTANCE, PgBossService, QueueRegistry],
  };
}

@Module({})
export class PgBossModule extends ConfigurableModuleClass {
  /** Configure pg-boss once, in the root module. */
  static override forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    return asGlobalCore(super.forRoot(options));
  }

  /** Same as `forRoot`, with `useFactory` / `useClass` / `useExisting`, e.g. to read `ConfigService`. */
  static override forRootAsync(options: typeof ASYNC_OPTIONS_TYPE): DynamicModule {
    return asGlobalCore(super.forRootAsync(options));
  }

  /**
   * Declare queues in the module that owns them. Each is created (or reconciled) on boot and can be
   * injected with `@InjectQueue(name)`. A bare string declares a queue with pg-boss defaults.
   */
  static registerQueue(...queues: (string | QueueDefinition)[]): DynamicModule {
    const definitions = queues.map((queue): QueueDefinition => (typeof queue === 'string' ? { name: queue } : queue));

    // The definition is also a `useValue` provider so it is part of the module's metadata. Nest
    // identifies a dynamic module by hashing that metadata (function bodies by their source text), so
    // options held only in a closure would make two different declarations of one queue look identical.
    const providers = definitions.flatMap((definition): (Provider | FactoryProvider<JobQueue>)[] => {
      const definitionToken = `${getQueueToken(definition.name)}:definition`;
      return [
        { provide: definitionToken, useValue: definition },
        {
          provide: getQueueToken(definition.name),
          inject: [definitionToken, QueueRegistry, PGBOSS_INSTANCE],
          useFactory: async (declared: QueueDefinition, registry: QueueRegistry, boss: PgBoss) => {
            registry.declare(declared);
            await registry.ensure(declared.name);
            return new JobQueue(declared.name, boss);
          },
        },
      ];
    });

    return {
      module: PgBossModule,
      providers,
      exports: definitions.map((definition) => getQueueToken(definition.name)),
    };
  }
}
