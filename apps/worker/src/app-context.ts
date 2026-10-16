import { createAiAdapters } from './integrations/ai/registry';
import { createAiService, createAiGovernance } from './modules/ai';
import { readAiConfiguration } from './modules/admin';
import { decrypt, importEncryptionKey } from './platform/crypto';
import { readSecret } from './platform/secrets';
import type { AiService } from '@unimailbox/contracts';
import type { ResourceUsageReader } from '@unimailbox/contracts';
import { createResourceUsageReader } from './integrations/cloudflare/resource-usage';
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
import type { AuditEventWriter, BlocklistReader, RolePolicyReader } from '@unimailbox/contracts';
import {
  createAuditEventWriter,
  createBlocklistReader,
  createRolePolicyReader,
} from './modules/admin';

export interface AppContext {
  readonly resourceUsage: ResourceUsageReader;
  readonly ai: AiService<AbortSignal>;
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
  // D-CAP-021 / CAP-035: cross-module readers for inbound-mail.
  // Wired through app-context (composition root) — see ADR-002 for the
  // outbound-provider-registry equivalent.
  readonly blocklistReader: BlocklistReader;
  readonly rolePolicyReader: RolePolicyReader;
  // CAP-040 / D-CAP-029-A: cross-module writer so the webhook route can
  // fold its audit row into the same D1 batch as the messages UPDATE and
  // webhook_deliveries INSERT (no unaudited transitions). Mirrors the
  // BlocklistReader / RolePolicyReader seams.
  readonly auditEventWriter: AuditEventWriter;
}

export function buildAppContext(env: Env): AppContext {
  const db = getDatabase(env);
  const analyticsToken = env.CLOUDFLARE_ANALYTICS_TOKEN;
  return {
    db,
    resourceUsage: createResourceUsageReader({
      ...(env.CLOUDFLARE_ANALYTICS_CONFIG ? { config: env.CLOUDFLARE_ANALYTICS_CONFIG } : {}),
      ...(analyticsToken ? { token: () => readSecret(analyticsToken) } : {}),
      cache: caches.default,
    }),
    ai: createAiService({
      adapters: createAiAdapters(env.AI),
      governance: createAiGovernance(db, createAuditEventWriter(db)),
      loadConfiguration: async () => {
        const snapshot = await readAiConfiguration(db);
        const apiKey =
          snapshot.configuration.enabled && snapshot.credential
            ? await decrypt(
                snapshot.credential,
                await importEncryptionKey(await readSecret(env.CREDENTIAL_ENCRYPTION_KEY)),
              )
            : null;
        return { configuration: snapshot.configuration, apiKey, revision: snapshot.revision };
      },
    }),
    cache: getCache(env),
    setupSessionStore: getSetupSessionStore(env),
    objectStore: getObjectStore(env),
    config: loadConfig(env),
    clock: systemClock,
    ids: systemIds,
    logger,
    blocklistReader: createBlocklistReader(db),
    rolePolicyReader: createRolePolicyReader(db),
    auditEventWriter: createAuditEventWriter(db),
  };
}
