# CAP-013 — `POST /api/v1/setup/inbound-smoke-test` — generated message reaches the Worker

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## Goal

Verify that Cloudflare Email Routing is correctly configured: an email sent to the managed domain
actually reaches the Worker's `email` handler. The operator triggers the test, sends an email to
the generated address, and the system confirms receipt. After confirmation, the step advances to `brevo`.

This is the first capability that modifies the **inbound email handler** (previously a reject-all stub).

## Scope

- **`startInboundSmokeTest` use case** (`modules/onboarding/inbound-smoke-test.ts`, new).
  - Checks managed domain exists (via tenancy `getManagedDomain`).
  - Generates a smoke test token (UUID via `ids.uuid()`).
  - Stores `smoke:{token}` in CACHE KV with `{ domain, createdAt }` and 5-minute TTL.
  - Returns `{ smokeTestAddress: "smoke+<token>@<domain>" }`.
  - Does NOT advance the step (message hasn't arrived yet).

- **`checkInboundSmokeTest` use case** (same file).
  - Reads `smoke:active` from CACHE KV to get the current token.
  - Reads `smoke-result:{token}` from CACHE KV.
  - If found → advance step to `'brevo'`, return `{ status: "received" }`.
  - If not → return `{ status: "pending" }`.

- **`handleSmokeTestMessage` function** (same file).
  - Parses the `to` address for `smoke+<token>@` pattern.
  - If match and token exists in CACHE KV → sets `smoke-result:{token}`, returns `true`.
  - Otherwise → returns `false` (not a smoke test message).
  - Called by the email handler entrypoint.

- **Email handler modification** (`entrypoints/inbound-email.ts`).
  - Adds `env: Env` parameter.
  - Calls `handleSmokeTestMessage(message.to, env.CACHE)` first.
  - If handled → return (accept message).
  - If not → `message.setReject(...)` (unchanged behavior for non-smoke-test messages).

- **Two route handlers** in `http/routes/setup.ts`:
  - `POST /api/v1/setup/inbound-smoke-test` — starts the test (session-protected).
  - `POST /api/v1/setup/inbound-smoke-test/check` — checks the result (session-protected).

- **Worker-pool tests**.

## Out of scope

- **Full inbound email processing** (MIME parse, persist message) — CAP-021.
- **Automated email sending** (Worker can't send email to itself; the operator sends manually).
- **Real Cloudflare API verification** — the email handler IS the verification. If the message
  arrives at the handler, email routing works.
- **Brevo provider setup** — CAP-014.

## How it works

1. Operator clicks "Start Inbound Smoke Test" → `POST /inbound-smoke-test`
2. Worker generates `smoke+<uuid>@<domain>` and returns it to the operator
3. Operator sends an email from their email client to that address
4. Cloudflare Email Routing forwards the email to the Worker's `email` handler
5. The handler detects the `smoke+` prefix, validates the token, sets a KV flag
6. Operator clicks "Check" → `POST /inbound-smoke-test/check`
7. Worker finds the KV flag → advances step to `brevo`

**Prerequisite:** The operator must have configured a catch-all Email Routing rule in Cloudflare
(step 10 in the setup wizard — CAP-012) so that `*@<domain>` reaches the Worker.

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/inbound-smoke-test` with a valid session + existing domain returns 200 with `{"data":{"smokeTestAddress":"smoke+<uuid>@<domain>"}}`.
- [ ] 2. After starting, a smoke test token exists in CACHE KV.
- [ ] 3. `POST /api/v1/setup/inbound-smoke-test/check` before any email returns `{ status: "pending" }`.
- [ ] 4. After the email handler processes a matching message, `check` returns `{ status: "received" }` and advances step to `'brevo'`.
- [ ] 5. The email handler accepts messages with `smoke+<token>@` prefix when the token is valid.
- [ ] 6. The email handler rejects all other messages (unchanged behavior).
- [ ] 7. No domain → 409 on start.
- [ ] 8. Both endpoints require a valid session → 401 without one.
- [ ] 9. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 10. `pnpm scaffold doctor` exits 0 (10/10).

## File ownership

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/modules/onboarding/inbound-smoke-test.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/entrypoints/inbound-email.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/routes/inbound-smoke-test.worker.test.ts` (new) |

## Reading list

- `CLAUDE.md` and this task file
- `.claude/rules/architecture.md` — §Shape (entrypoints are thin shells), §Dependency direction
- `.claude/rules/coding.md` — §Structure, §Errors
- `.claude/rules/testing.md` — §Mocking (mock email message is OK — it's not D1/R2/KV/Queue)
- Existing code:
  - `apps/worker/src/entrypoints/inbound-email.ts` (the stub you're modifying)
  - `apps/worker/src/worker.ts` (how email handler is wired)
  - `apps/worker/src/platform/env.ts` (Env type — CACHE binding)
  - `apps/worker/src/modules/onboarding/cloudflare-verify.ts` (use case pattern)
  - `apps/worker/src/modules/onboarding/installation-state-repository.ts` (updateInstallationStep)
  - `apps/worker/src/modules/tenancy/domain-repository.ts` (getManagedDomain)
  - `apps/worker/src/http/routes/setup.ts` (current setup routes)
  - `apps/worker/src/http/middleware/setup-session.ts` (session middleware)
  - `apps/worker/src/http/routes/cloudflare.worker.test.ts` (test pattern)
  - `packages/test-kit/src/seed.ts` (test helpers)

## Design guidance

### Use cases (modules/onboarding/inbound-smoke-test.ts)

```typescript
import type { Database } from '../../platform/database';
import type { SetupSessionStore } from '../../platform/cache'; // No — use Cache
import type { Cache } from '../../platform/cache';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import { getManagedDomain } from '../tenancy';
import { updateInstallationStep } from './installation-state-repository';

const SMOKE_TTL_SECONDS = 300; // 5 minutes
const SMOKE_PREFIX = 'smoke+';

// --- Start ---

export interface StartSmokeTestInput {
  readonly db: Database;
  readonly cache: Cache;
}

export interface StartSmokeTestResult {
  readonly smokeTestAddress: string;
}

export async function startInboundSmokeTest(
  input: StartSmokeTestInput,
  deps: { ids: IdGenerator },
): Promise<StartSmokeTestResult> {
  const domain = await getManagedDomain(input.db);
  if (!domain) {
    throw new DomainError({
      code: 'SETUP_DOMAIN_REQUIRED',
      message: 'A managed domain must be created before the smoke test',
      httpStatus: 409,
    });
  }

  const token = deps.ids.uuid();
  await input.cache.put(`smoke:${token}`, JSON.stringify({ domain: domain.name }), {
    expirationTtl: SMOKE_TTL_SECONDS,
  });
  // Track the active token for the check endpoint
  await input.cache.put('smoke:active', token, { expirationTtl: SMOKE_TTL_SECONDS });

  return { smokeTestAddress: `${SMOKE_PREFIX}${token}@${domain.name}` };
}

// --- Check ---

export interface CheckSmokeTestResult {
  readonly status: 'received' | 'pending';
}

export async function checkInboundSmokeTest(
  input: { db: Database; cache: Cache },
  deps: { clock: Clock },
): Promise<CheckSmokeTestResult> {
  const token = await input.cache.get('smoke:active');
  if (!token) {
    return { status: 'pending' };
  }

  const result = await input.cache.get(`smoke-result:${token}`);
  if (!result) {
    return { status: 'pending' };
  }

  // Received! Advance step to 'brevo'.
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await updateInstallationStep(input.db, 'brevo', now);

  return { status: 'received' };
}

// --- Email handler detection ---

export async function handleSmokeTestMessage(
  to: string,
  cache: Cache,
): Promise<boolean> {
  // Parse smoke+<token>@<domain> pattern
  const match = to.match(/^smoke\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
  if (!match) return false;

  const token = match[1] ?? '';
  // Validate the token is a pending smoke test
  const pending = await cache.get(`smoke:${token}`);
  if (!pending) return false;

  // Mark as received
  await cache.put(`smoke-result:${token}`, '1', { expirationTtl: SMOKE_TTL_SECONDS });
  return true;
}
```

### Email handler modification (entrypoints/inbound-email.ts)

```typescript
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Env } from '../platform/env';
import { handleSmokeTestMessage } from '../modules/onboarding';

const REJECTION_REASON = 'Inbound email not yet enabled. Only smoke-test messages are accepted during setup.';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // Check if this is a smoke test message during setup
    const handled = await handleSmokeTestMessage(message.to, env.CACHE);
    if (handled) return;

    // Not a smoke test — reject until full inbound processing lands (CAP-021)
    await message.setReject(REJECTION_REASON);
  },
};
```

### Route handlers

```typescript
// POST /inbound-smoke-test — start
routes.post('/inbound-smoke-test', setupSession, async (c) => {
  const result = await startInboundSmokeTest(
    { db: c.env.DB, cache: c.env.CACHE },
    { ids: systemIds },
  );
  return c.json({ data: result });
});

// POST /inbound-smoke-test/check — check result
routes.post('/inbound-smoke-test/check', setupSession, async (c) => {
  const result = await checkInboundSmokeTest(
    { db: c.env.DB, cache: c.env.CACHE },
    { clock: systemClock },
  );
  return c.json({ data: result });
});
```

### Test approach

1. **Start endpoint**: claim session → seed domain → POST /inbound-smoke-test → verify 200 + smokeTestAddress format + KV has token.
2. **Check endpoint (pending)**: start → POST /check → verify `{ status: "pending" }`.
3. **Check endpoint (received)**: start → simulate email received by setting KV flag → POST /check → verify `{ status: "received" }` + step = 'brevo'.
4. **Email handler**: import handler, call with mock message where `to` matches `smoke+<token>@domain` → verify KV flag set. Call with non-matching `to` → verify rejection.
5. **No domain → 409**, **no session → 401**.

For the mock email message, create a minimal object satisfying `ForwardableEmailMessage`:
```typescript
const mockMessage = {
  to: 'smoke+<token>@example.com',
  from: 'sender@example.org',
  headers: new Headers(),
  raw: new ReadableStream(),
  rawSize: 0,
  setReject: async (reason: string) => {},
  forward: async (address: string) => {},
  reply: async (message: unknown) => {},
};
```

This is NOT mocking D1/R2/KV/Queue — it's mocking the Cloudflare email message interface, which is allowed.

## Decisions

1. **Operator sends the email manually.** The Worker cannot send email to itself (no outbound provider yet). The smoke test generates the target address; the operator sends from their email client.
2. **CACHE KV for smoke test state.** Ephemeral data with TTL — no migration needed. The `smoke:` prefix avoids collision with future cache keys.
3. **Email handler now accepts smoke test messages.** All other messages are still rejected until CAP-021. The handler uses the `smoke+` prefix to distinguish.
4. **Two endpoints (start + check).** The start endpoint generates the address; the check endpoint polls for receipt. The frontend calls start once, then polls check.

## Open questions

(None.)
