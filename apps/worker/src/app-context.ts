// Composition root — the only place wiring happens.
// CAP-001 stub: returns named collaborators so use cases cannot reach back
// into the raw Cloudflare `Env` (per ADR-007 + .claude/rules/security.md
// §Secrets). Real repository / service wiring lands with the modules that
// own them.
import type { Cache, SetupSessionStore } from './platform/cache';
import type { PlatformConfig } from './platform/config';
import type { Database } from './platform/database';
import type { Env } from './platform/env';
import type { ObjectStore } from './platform/object-store';
import { getCache, getSetupSessionStore } from './platform/cache';
import { loadConfig } from './platform/config';
import { getDatabase } from './platform/database';
import { getObjectStore } from './platform/object-store';
import { systemClock, type Clock } from './platform/clock';
import { systemIds, type IdGenerator } from './platform/ids';
import { logger, type LogFields, type LogContext } from './platform/logger';

export interface AppContext {
  readonly db: Database;
  readonly cache: Cache;
  readonly setupSessionStore: SetupSessionStore;
  readonly objectStore: ObjectStore;
  readonly config: PlatformConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: {
    readonly debug: (fields: LogFields, context?: LogContext) => void;
    readonly info: (fields: LogFields, context?: LogContext) => void;
    readonly warn: (fields: LogFields, context?: LogContext) => void;
    readonly error: (fields: LogFields, context?: LogContext) => void;
  };
}

export function buildAppContext(env: Env): AppContext {
  return {
    db: getDatabase(env),
    cache: getCache(env),
    setupSessionStore: getSetupSessionStore(env),
    objectStore: getObjectStore(env),
    config: loadConfig(env),
    clock: systemClock,
    ids: systemIds,
    logger,
  };
}