# CAP-015 + CAP-016 — Outbound smoke test + Setup complete

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## CAP-015 — `POST /api/v1/setup/outbound-smoke-test`

Sends a test email via the Brevo adapter (configured in CAP-014). Decrypts the stored API key,
constructs a test message from `noreply@<domain>` to the admin's email, sends it, and confirms
the provider accepted it. Advances step to `complete`.

### Scope

- **`getFirstUser`** in identity (`user-repository.ts`) — `SELECT id, email FROM users ORDER BY created_at LIMIT 1`. Export from identity `index.ts`.
- **`getCredentialByName`** in outbound-mail (`credential-repository.ts`) — reads encrypted_credentials by name. Export from outbound-mail `index.ts`.
- **`runOutboundSmokeTest` use case** (`modules/onboarding/outbound-smoke-test.ts`):
  1. Read admin user (identity `getFirstUser`)
  2. Read managed domain (tenancy `getManagedDomain`)
  3. Read encrypted credential (outbound-mail `getCredentialByName('brevo-api-key')`)
  4. Decrypt the API key (platform/crypto `importEncryptionKey` + `decrypt`)
  5. Construct `SendProviderMessage` — from `noreply@<domain>`, to admin email, subject "Unimailbox Setup Smoke Test"
  6. Call `adapter.send(ctx, msg)` — throws on failure
  7. Advance step to `'complete'`
  8. Return `{ providerMessageId }`
- **Route**: `POST /api/v1/setup/outbound-smoke-test` (session-protected).
- **Tests**: mock Brevo send API via fetch spy. Verify step advances. Verify 502 on send failure.

### Acceptance criteria

- [ ] 1. `POST /outbound-smoke-test` with valid session + configured Brevo returns 200 with `{"data":{"providerMessageId":"<id>"}}`.
- [ ] 2. After success, `GET /setup/status` returns `currentStep: 'complete'`.
- [ ] 3. Brevo API error → 502 PROVIDER_SEND_FAILED.
- [ ] 4. No session → 401.
- [ ] 5. Response does NOT include the decrypted API key.

---

## CAP-016 — `POST /api/v1/setup/complete` + `GET /` serves the app shell

Flips `installation_state.status` to `'complete'` and `current_step` to `'complete'`. After this,
the setup gate (CAP-006) stops redirecting — `GET /` returns the React app shell instead of 302.

### Scope

- **`completeSetup` use case** (`modules/onboarding/complete-setup.ts`):
  - `UPDATE installation_state SET status = 'complete', current_step = 'complete', updated_at = ?`
  - Return `{ status: 'complete' }`
- **Route**: `POST /api/v1/setup/complete` (session-protected).
- **`GET /` handler** in `http/router.ts` — returns a minimal HTML shell when installation is complete. The setup gate (CAP-006) already passes through when status='complete', so `GET /` is reachable.
- **Tests**: complete → 200 + status verified. After complete, `GET /` returns 200 HTML (not 302). Before complete, `GET /` still 302s.

### Acceptance criteria

- [ ] 1. `POST /complete` with valid session returns 200 with `{"data":{"status":"complete"}}`.
- [ ] 2. After complete, `GET /setup/status` returns `{ status: 'complete', currentStep: 'complete' }`.
- [ ] 3. After complete, `GET /` returns 200 with HTML (not 302 to /setup).
- [ ] 4. No session → 401.

---

## File ownership

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/modules/identity/user-repository.ts` (add getFirstUser) |
| implementer | `apps/worker/src/modules/identity/index.ts` |
| implementer | `apps/worker/src/modules/outbound-mail/credential-repository.ts` (add getCredentialByName) |
| implementer | `apps/worker/src/modules/outbound-mail/index.ts` |
| implementer | `apps/worker/src/modules/onboarding/outbound-smoke-test.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/complete-setup.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/installation-state-repository.ts` (add completeInstallationState) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/router.ts` (add GET / handler) |
| implementer | `apps/worker/src/http/routes/outbound-smoke-test.worker.test.ts` (new) |
| implementer | `apps/worker/src/http/routes/complete-setup.worker.test.ts` (new) |

## Reading list

- `work/active/CAP-015-016-setup-finish/task.md` (this file)
- `.claude/rules/architecture.md` — §API conventions, §Dependency direction
- `.claude/rules/coding.md` — §Data, §Errors
- `apps/worker/src/modules/onboarding/setup-brevo.ts` (pattern: decrypt credential, call adapter)
- `apps/worker/src/modules/outbound-mail/credential-repository.ts` (credential repo)
- `apps/worker/src/integrations/providers/brevo.ts` (adapter — validateConnection + send)
- `apps/worker/src/platform/crypto.ts` (importEncryptionKey, encrypt, decrypt)
- `apps/worker/src/http/routes/setup.ts` (current setup routes)
- `apps/worker/src/http/routes/brevo.worker.test.ts` (test pattern — mock fetch)
- `packages/contracts/src/index.ts` (SendProviderMessage, MailAddress, EmailAddress)
- `apps/worker/src/http/router.ts` (where to add GET /)
- `apps/worker/src/http/middleware/setup-gate.ts` (how the gate works)

## Design guidance

### getFirstUser (identity)

```typescript
export async function getFirstUser(db: Database): Promise<{ id: string; email: string } | null> {
  return db.prepare('SELECT id, email FROM users ORDER BY created_at LIMIT 1')
    .first<{ id: string; email: string }>();
}
```

### getCredentialByName (outbound-mail)

```typescript
export async function getCredentialByName(db: Database, name: string): Promise<{
  id: string; ciphertext: ArrayBuffer; iv: ArrayBuffer; auth_tag: ArrayBuffer; version: number;
} | null> {
  return db.prepare('SELECT id, ciphertext, iv, auth_tag, version FROM encrypted_credentials WHERE name = ? LIMIT 1')
    .bind(name).first();
}
```

### runOutboundSmokeTest use case

```typescript
export async function runOutboundSmokeTest(
  input: { db: Database; encryptionKey: string; adapter: OutboundProviderAdapter },
  deps: { clock: Clock; ids: IdGenerator },
): Promise<{ providerMessageId: string }> {
  // Read admin + domain + credential
  const admin = await getFirstUser(input.db);
  if (!admin) throw new DomainError({ code: 'SETUP_ADMINISTRATOR_REQUIRED', message: 'No administrator exists', httpStatus: 409 });
  const domain = await getManagedDomain(input.db);
  if (!domain) throw new DomainError({ code: 'SETUP_DOMAIN_REQUIRED', message: 'No managed domain', httpStatus: 409 });
  const cred = await getCredentialByName(input.db, 'brevo-api-key');
  if (!cred) throw new DomainError({ code: 'SETUP_BREVO_NOT_CONFIGURED', message: 'Brevo not configured', httpStatus: 409 });

  // Decrypt API key
  const key = await importEncryptionKey(input.encryptionKey);
  const apiKey = await decrypt({
    ciphertext: new Uint8Array(cred.ciphertext),
    iv: new Uint8Array(cred.iv),
    authTag: new Uint8Array(cred.auth_tag),
  }, key);

  // Construct and send message
  const ctx: ProviderRuntimeContext = { env: { BREVO_API_KEY: apiKey } };
  const msg: SendProviderMessage = {
    idempotencyKey: deps.ids.uuid(),
    from: { address: `noreply@${domain.name}` },
    to: [{ address: admin.email }],
    cc: [], bcc: [],
    subject: 'Unimailbox Setup Smoke Test',
    html: '<p>This is a test message from Unimailbox setup.</p>',
    text: 'This is a test message from Unimailbox setup.',
    attachments: [],
  };
  const result = await input.adapter.send(ctx, msg);

  // Advance step
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await updateInstallationStep(input.db, 'complete', now);

  return { providerMessageId: result.providerMessageId };
}
```

### completeSetup use case

```typescript
export async function completeSetup(
  input: { db: Database },
  deps: { clock: Clock },
): Promise<{ status: 'complete' }> {
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await input.db.prepare(
    'UPDATE installation_state SET status = ?, current_step = ?, updated_at = ? WHERE id = 1',
  ).bind('complete', 'complete', now).run();
  return { status: 'complete' };
}
```

### GET / handler (router.ts)

```typescript
router.get('/', (c) => {
  // Minimal HTML shell — the setup gate ensures this is only reachable
  // when installation_state.status === 'complete'.
  return c.html('<!DOCTYPE html><html><head><title>Unimailbox</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>');
});
```

Note: The real React app assets will be served via a CDN or Workers Sites in production.
This is the minimal shell that proves the setup gate passes through.

### Route handlers

```typescript
// POST /outbound-smoke-test
routes.post('/outbound-smoke-test', setupSession, async (c) => {
  const encryptionKey = await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY);
  const result = await runOutboundSmokeTest(
    { db: c.env.DB, encryptionKey, adapter: brevoAdapter },
    { clock: systemClock, ids: systemIds },
  );
  return c.json({ data: result });
});

// POST /complete
routes.post('/complete', setupSession, async (c) => {
  const result = await completeSetup({ db: c.env.DB }, { clock: systemClock });
  return c.json({ data: result });
});
```

## Constraints

- Do not commit. No `any`. Never mock D1/KV. Mock Brevo API via fetch spy.
- CAP-015 first, then CAP-016.
- D1 BLOB columns return ArrayBuffer — use `new Uint8Array()` for decrypt.
- `GET /` must be in `router.ts` (not the setup sub-app) so the setup gate middleware applies to it.

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
