/** Injection token for the underlying, already-started `PgBoss` instance. */
export const PGBOSS_INSTANCE = Symbol('PGBOSS_INSTANCE');

export const PGBOSS_LOGGER_CONTEXT = 'PgBoss';

/** Prefix used to build the injection token of a registered queue. */
export const QUEUE_TOKEN_PREFIX = 'PgBossQueue';
