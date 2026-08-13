# CAP-014 — Provider registry + Brevo adapter; `POST /setup/brevo` encrypts the key (ADR-002, ADR-007)

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## Goal

The operator enters their Brevo API key. The system encrypts it (AES-GCM via `CREDENTIAL_ENCRYPTION_KEY`),
validates the connection by calling the Brevo API, stores the encrypted credential + provider connection,
links it to the managed domain, and advances the step to `outbound-smoke`.

This introduces the **outbound-mail module**, the **provider registry**, the **Brevo adapter**, and
**AES-GCM encryption** in platform/crypto.ts.

## Architecture decision — new module edge

`onboarding → outbound-mail` — the setup wizard's brevo step creates a provider connection (owned by
outbound-mail). Same orchestrator-approved pattern as `onboarding → identity` (CAP-010) and
`onboarding → tenancy` (CAP-011).

## Scope

- **New migration** `0003_provider_connections.sql` — `provider_connections` table.
- **AES-GCM encrypt/decrypt** in `platform/crypto.ts` — uses `CREDENTIAL_ENCRYPTION_KEY` from Secrets Store.
- **Outbound-mail module** (`modules/outbound-mail/`):
  - `credential-repository.ts` — insert/read `encrypted_credentials`.
  - `connection-repository.ts` — insert/read `provider_connections`, prepared statements for batch.
  - `index.ts` — exports.
- **Provider registry** (`integrations/providers/provider-registry.ts`) — maps `ProviderKey` → adapter.
- **Brevo adapter** (`integrations/providers/brevo.ts`) — `validateConnection` (GET /v3/account) + `send` (POST /v3/smtp/email).
- **`setupBrevo` use case** (`modules/onboarding/setup-brevo.ts`) — validate → encrypt → batch(insert credential + insert connection + update domain + advance step).
- **`POST /api/v1/setup/brevo` route** — session-protected.
- **Contracts** — `setupBrevoRequestSchema`.
- **Schema version bump** to '0003'.
- **Worker-pool tests** — mock fetch for Brevo API, real D1/KV.

## Out of scope

- **Outbound smoke test** (actual email send) — CAP-015.
- **Webhook handling** — CAP-024.
- **Provider sync** — Phase 5.
- **Resend / CF-Sendmail adapters** — Phase 5.
- **Key rotation / re-encryption** — Phase 4 maintenance job.
- **Idempotency-Key** — deferred to CAP-027.

## ADR references

- **ADR-002**: Provider Registry Pattern — adapters implement `OutboundProviderAdapter`, use cases call through the interface.
- **ADR-007**: Two-layer secret storage — encryption key in Secrets Store, encrypted payload in D1 (AES-GCM).

## Business rules

| Rule ID | What it means |
|---|---|
| R-SECRET-002 | Provider API keys live in `encrypted_credentials`, encrypted with AES-GCM. |
| R-SECRET-003 | Secrets are never logged, never returned in an API response. |
| ADR-002 | Modules call adapters through the `OutboundProviderAdapter` interface — never the SDK directly. |

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/brevo` with valid API key + session returns 200 with `{"data":{"connectionId":"<uuid>","providerKey":"brevo","status":"active"}}`.
- [ ] 2. The API key is stored encrypted in `encrypted_credentials` (ciphertext + iv + auth_tag BLOBs, not plaintext).
- [ ] 3. A `provider_connections` row exists with `provider_key='brevo'`, `status='active'`.
- [ ] 4. `managed_domains.outbound_connection_id` points to the new connection.
- [ ] 5. After setup, `GET /api/v1/setup/status` returns `currentStep: 'outbound-smoke'`.
- [ ] 6. Invalid API key (Brevo API returns 401) → 502 PROVIDER_CONNECTION_FAILED.
- [ ] 7. The response does NOT include the API key or any decrypted credential.
- [ ] 8. Both endpoints require a valid session → 401 without one.
- [ ] 9. `encrypt`/`decrypt` round-trip unit-tested.
- [ ] 10. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 11. `pnpm scaffold doctor` exits 0 (10/10).

## File ownership

| Agent | Owns |
|---|---|
| implementer | `migrations/0003_provider_connections.sql` (new) |
| implementer | `migrations/0003_provider_connections.verify.sql` (new) |
| implementer | `apps/worker/src/database/schema/outbound-mail.ts` (add provider_connections) |
| implementer | `apps/worker/src/database/schema/index.ts` |
| implementer | `apps/worker/src/database/schema-version.ts` |
| implementer | `apps/worker/src/platform/crypto.ts` (add encrypt/decrypt) |
| implementer | `apps/worker/src/platform/crypto.test.ts` (add encrypt/decrypt tests) |
| implementer | `apps/worker/src/modules/outbound-mail/index.ts` (new) |
| implementer | `apps/worker/src/modules/outbound-mail/credential-repository.ts` (new) |
| implementer | `apps/worker/src/modules/outbound-mail/connection-repository.ts` (new) |
| implementer | `apps/worker/src/integrations/providers/provider-registry.ts` (new) |
| implementer | `apps/worker/src/integrations/providers/brevo.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/setup-brevo.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `packages/contracts/src/index.ts` (add setupBrevoRequestSchema) |
| implementer | `packages/contracts/src/index.test.ts` |
| implementer | `packages/test-kit/src/migrationsDb.ts` (add 0003 migration) |
| implementer | `scripts/doctor.ts` (ALLOWED set: add outbound-mail to onboarding) |
| implementer | `apps/worker/src/http/routes/brevo.worker.test.ts` (new) |

## Reading list

- `CLAUDE.md` and this task file
- `.claude/rules/architecture.md` — §Dependency direction, §Integrations, §Forbidden, §Persistence ownership
- `.claude/rules/coding.md` — §Data (D1 batch), §Errors, §Dependencies
- `.claude/rules/security.md` — §Secrets (ADR-007), §Passwords (constant-time)
- `docs/rebuild/09-decisions/ADR-002-provider-registry.md`
- `docs/rebuild/09-decisions/ADR-007-encrypted-credentials.md`
- `docs/rebuild/E-proposed-domain-model.md` lines 140-170 (ProviderConnection)
- `packages/contracts/src/index.ts` (OutboundProviderAdapter, ProviderRuntimeContext, SendProviderMessage)
- Existing code:
  - `migrations/0001_initial.sql` lines 112-127 (encrypted_credentials DDL)
  - `migrations/0002_managed_domains.sql` (migration format)
  - `apps/worker/src/database/schema/outbound-mail.ts` (encrypted_credentials Drizzle typing)
  - `apps/worker/src/platform/crypto.ts` (current: constantTimeCompare + hashPassword)
  - `apps/worker/src/platform/secrets.ts` (readSecret for CREDENTIAL_ENCRYPTION_KEY)
  - `apps/worker/src/modules/onboarding/create-administrator.ts` (batch + guard pattern)
  - `apps/worker/src/modules/onboarding/create-domain.ts` (batch + guard pattern)
  - `apps/worker/src/modules/tenancy/domain-repository.ts` (getManagedDomain)
  - `apps/worker/src/http/routes/setup.ts` (current setup routes)
  - `apps/worker/src/http/middleware/setup-session.ts` (session middleware)
  - `packages/test-kit/src/stubs.ts` (stubFetch for mocking Brevo API)
  - `packages/test-kit/src/migrationsDb.ts` (migration fixture)
  - `scripts/doctor.ts` (ALLOWED set)

## Design guidance

### Migration (0003_provider_connections.sql)

```sql
CREATE TABLE IF NOT EXISTS provider_connections (
  id              TEXT PRIMARY KEY,
  provider_key    TEXT NOT NULL,
  label           TEXT NOT NULL,
  credential_id   TEXT NOT NULL REFERENCES encrypted_credentials(id),
  status          TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'invalid')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_provider_connections.sql');
```

### AES-GCM encrypt/decrypt (platform/crypto.ts)

```typescript
export interface EncryptedData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

export async function importEncryptionKey(rawKey: string): Promise<CryptoKey> {
  // The key from Secrets Store is a hex string. Convert to bytes.
  const keyBytes = new Uint8Array(
    rawKey.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [],
  );
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(plaintext: string, key: CryptoKey): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  // AES-GCM returns ciphertext + authTag concatenated (last 16 bytes = tag)
  const bytes = new Uint8Array(encrypted);
  const ciphertext = bytes.slice(0, bytes.length - 16);
  const authTag = bytes.slice(bytes.length - 16);
  return { ciphertext, iv, authTag };
}

export async function decrypt(data: EncryptedData, key: CryptoKey): Promise<string> {
  // Re-concatenate ciphertext + authTag for decrypt
  const combined = new Uint8Array(data.ciphertext.length + data.authTag.length);
  combined.set(data.ciphertext);
  combined.set(data.authTag, data.ciphertext.length);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.iv },
    key,
    combined,
  );
  return new TextDecoder().decode(decrypted);
}
```

### Brevo adapter (integrations/providers/brevo.ts)

```typescript
import type {
  OutboundProviderAdapter,
  ProviderKey,
  ProviderRuntimeContext,
  SendProviderMessage,
  ProviderSendResult,
} from '@unimailbox/contracts';
import { parseProviderKey } from '@unimailbox/contracts';
import { DomainError } from '../../platform/errors';

const BREVO_API_BASE = 'https://api.brevo.com/v3';

export const brevoAdapter: OutboundProviderAdapter = {
  key: parseProviderKey('brevo'),

  async validateConnection(ctx: ProviderRuntimeContext): Promise<void> {
    const apiKey = ctx.env.BREVO_API_KEY;
    if (typeof apiKey !== 'string') {
      throw new DomainError({ code: 'PROVIDER_CONFIG_ERROR', message: 'Missing API key', httpStatus: 500 });
    }
    const response = await fetch(`${BREVO_API_BASE}/account`, {
      headers: { 'api-key': apiKey },
    });
    if (!response.ok) {
      throw new DomainError({
        code: 'PROVIDER_CONNECTION_FAILED',
        message: `Brevo validation failed: ${response.status}`,
        httpStatus: 502,
      });
    }
  },

  async send(ctx, msg): Promise<ProviderSendResult> {
    // Full implementation for CAP-015. For CAP-014, a basic version is fine.
    const apiKey = ctx.env.BREVO_API_KEY;
    // ... POST to /smtp/email
  },
};
```

### setupBrevo use case (modules/onboarding/setup-brevo.ts)

```typescript
export async function setupBrevo(
  input: {
    db: Database;
    encryptionKey: string;       // raw hex from CREDENTIAL_ENCRYPTION_KEY
    apiKey: string;              // plaintext from request body
    adapter: OutboundProviderAdapter;
  },
  deps: { clock: Clock; ids: IdGenerator },
): Promise<{ connectionId: string; providerKey: string; status: string }> {
  // 1. Validate the API key via the adapter
  const ctx: ProviderRuntimeContext = {
    env: { BREVO_API_KEY: input.apiKey },
  };
  await input.adapter.validateConnection(ctx); // throws on failure

  // 2. Encrypt the API key
  const key = await importEncryptionKey(input.encryptionKey);
  const encrypted = await encrypt(input.apiKey, key);

  // 3. Generate IDs and timestamp
  const credentialId = deps.ids.uuid();
  const connectionId = deps.ids.uuid();
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');

  // 4. Batch: insert credential + insert connection + update domain + advance step
  const stmts = [
    prepareCreateCredential(input.db, {
      id: credentialId, name: 'brevo-api-key', version: 1,
      ciphertext: encrypted.ciphertext, iv: encrypted.iv, authTag: encrypted.authTag,
      createdAt: now, updatedAt: now,
    }),
    prepareCreateConnection(input.db, {
      id: connectionId, providerKey: 'brevo', label: 'Brevo',
      credentialId, status: 'active', createdAt: now, updatedAt: now,
    }),
    input.db.prepare('UPDATE managed_domains SET outbound_connection_id = ?, updated_at = ? WHERE id = (SELECT id FROM managed_domains LIMIT 1)')
      .bind(connectionId, now),
    prepareUpdateInstallationStep(input.db, 'outbound-smoke', now),
  ];

  try {
    await input.db.batch(stmts);
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      throw new DomainError({ code: 'SETUP_BREVO_ALREADY_CONFIGURED', message: 'Brevo is already configured', httpStatus: 409 });
    }
    throw err;
  }

  return { connectionId, providerKey: 'brevo', status: 'active' };
}
```

### Route handler

```typescript
routes.post('/brevo', setupSession, async (c) => {
  const body = setupBrevoRequestSchema.parse(await c.req.json());
  const encryptionKey = await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY);
  const result = await setupBrevo(
    { db: c.env.DB, encryptionKey, apiKey: body.apiKey, adapter: brevoAdapter },
    { clock: systemClock, ids: systemIds },
  );
  return c.json({ data: result });
});
```

### Contract schema

```typescript
export const setupBrevoRequestSchema = z.object({
  apiKey: z.string().min(1),
});
```

### Test approach

- Mock the Brevo API using `stubFetch` from test-kit (or `vi.spyOn(globalThis, 'fetch')`)
- For valid key: mock `GET /account` → 200. Verify encrypted credential stored, connection created, domain updated, step advanced.
- For invalid key: mock `GET /account` → 401. Verify 502 response, nothing stored.
- Verify API key is NOT in the response.
- Unit test encrypt/decrypt round-trip.
- Use `readSecret` for CREDENTIAL_ENCRYPTION_KEY (provided as `'test-encryption-key'` via wrangler.test.jsonc vars).

**Important:** The test wrangler config (`wrangler.test.jsonc`) provides `CREDENTIAL_ENCRYPTION_KEY` as a string. But `importEncryptionKey` expects a hex string. Make the test key a valid 32-byte hex string (64 chars): e.g., `'a'.repeat(64)`.

## Decisions

1. **`onboarding → outbound-mail` edge approved** — setup wizard creates provider connections.
2. **Validation before encryption** — don't encrypt an invalid key. The adapter validates first.
3. **Four-statement D1 batch** — credential insert + connection insert + domain update + step advance, all atomic.
4. **`send` method included** in the adapter but fully exercised in CAP-015.
5. **Provider registry is minimal** — just maps key → adapter. Full `ProviderPlugin` with webhook/sync comes later.
6. **Encryption key format**: hex string from Secrets Store, converted to bytes via `importEncryptionKey`.

## Open questions

(None.)
