import { ConfigurableModuleBuilder } from '@nestjs/common';
import type { PgBossModuleOptions } from './interfaces/pg-boss-module-options.interface.js';

export const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN,
  OPTIONS_TYPE,
  ASYNC_OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<PgBossModuleOptions>({ moduleName: 'PgBoss' })
  .setClassMethodName('forRoot')
  .build();
