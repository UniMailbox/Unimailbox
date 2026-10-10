# CAP-012 — Cloudflare dashboard-link + `/setup/cloudflare/verify` Email Routing check

**Phase:** 1 · **Status:** In Progress · **Started:** 2026-08-13

## Goal

Two endpoints that bridge the operator from "domain created" to "email routing ready":

1. **`POST /api/v1/setup/cloudflare/dashboard-link`** — returns an allowlisted Cloudflare dashboard
   URL so the operator can enable Email Routing. Does NOT advance the step.

2. **`POST /api/v1/setup/cloudflare/verify`** — confirms a managed domain exists and advances the
   installation step to `inbound-smoke`. In Phase 1, this is an operator-confirmation step (the
   operator clicks "I've enabled Email Routing"). The actual email-delivery verification happens
   in CAP-013 (inbound smoke test). A real Cloudflare API check is deferred to when the
   `integrations/cloudflare/control-plane.ts` integration lands.

Both endpoints are session-protected (require a valid setup session from `/claim`).

## Scope

- **`getCloudflareDashboardLink` use case** in `modules/onboarding/cloudflare-dashboard-link.ts` (new).
  - Returns `{ url: string }` — an allowlisted Cloudflare dashboard URL.
  - No step advancement (the operator hasn't verified yet).

- **`verifyCloudflareEmailRouting` use case** in `modules/onboarding/cloudflare-verify.ts` (new).
  - Reads the managed domain (via tenancy module — `getManagedDomain`).
  - If no domain exists → throws `DomainError({ code: 'SETUP_DOMAIN_REQUIRED', httpStatus: 409 })`.
  - Advances `installation_state.current_step` to `'inbound-smoke'`.
  - Returns `{ verified: true, domain: string }`.

- **`getManagedDomain`** in `modules/tenancy/domain-repository.ts` — reads the first managed domain row.

- **Two route handlers** in `http/routes/setup.ts`:
  - `POST /cloudflare/dashboard-link` — session-protected, calls use case, returns URL.
  - `POST /cloudflare/verify` — session-protected, calls use case, returns verified + domain.

- **Worker-pool tests**.

## Out of scope

- **Real Cloudflare API verification** — checking Email Routing status via Cloudflare's REST API.
  Requires `integrations/cloudflare/control-plane.ts` (not yet implemented). The inbound smoke test
  (CAP-013) provides the real verification — an actual email must arrive.
- **Account-specific dashboard URL** — we don't store the Cloudflare account_id yet. The URL is
  the generic Cloudflare dashboard. A follow-up can construct a zone-specific deep link.
- **DNS record instructions** — the response could include MX/SPF records to configure. Deferred;
  the frontend can show static instructions.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-SETUP-003` | `/api/v1/setup/cloudflare/*` paths are exempt from the setup gate. |
| Setup flow | Dashboard-link does NOT advance the step. Verify advances to 'inbound-smoke'. |

## Acceptance criteria

- [ ] 1. `POST /api/v1/setup/cloudflare/dashboard-link` with a valid session returns 200 with `{"data":{"url":"https://dash.cloudflare.com"}}`.
- [ ] 2. `POST /api/v1/setup/cloudflare/verify` with a valid session + existing domain returns 200 with `{"data":{"verified":true,"domain":"<domain-name>"}}`.
- [ ] 3. After verify, `GET /api/v1/setup/status` returns `currentStep: 'inbound-smoke'`.
- [ ] 4. `POST /api/v1/setup/cloudflare/verify` when no domain exists returns 409.
- [ ] 5. Both endpoints require a valid session → 401 without one.
- [ ] 6. Dashboard-link does NOT change the installation step.
- [ ] 7. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
- [ ] 8. `pnpm scaffold doctor` exits 0 (10/10).

## File ownership

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/modules/tenancy/domain-repository.ts` (add `getManagedDomain`) |
| implementer | `apps/worker/src/modules/tenancy/index.ts` (export `getManagedDomain`) |
| implementer | `apps/worker/src/modules/onboarding/cloudflare-dashboard-link.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/cloudflare-verify.ts` (new) |
| implementer | `apps/worker/src/modules/onboarding/index.ts` |
| implementer | `apps/worker/src/http/routes/setup.ts` |
| implementer | `apps/worker/src/http/routes/cloudflare.worker.test.ts` (new) |

## Reading list

- `CLAUDE.md` and this task file
- `.claude/rules/architecture.md` — §API conventions, §Dependency direction
- `.claude/rules/coding.md` — §Structure, §Errors
- `.claude/rules/testing.md` — §Mocking, §Determinism
- Existing code:
  - `apps/worker/src/http/routes/setup.ts` (current setup routes)
  - `apps/worker/src/http/middleware/setup-session.ts` (session middleware)
  - `apps/worker/src/modules/onboarding/create-domain.ts` (use case pattern — batch + guard)
  - `apps/worker/src/modules/onboarding/installation-state-repository.ts` (prepareUpdateInstallationStep)
  - `apps/worker/src/modules/tenancy/domain-repository.ts` (add getManagedDomain)
  - `apps/worker/src/modules/tenancy/index.ts`
  - `apps/worker/src/http/routes/domain.worker.test.ts` (test pattern)
  - `packages/test-kit/src/seed.ts` (test helpers)

## Design guidance

### `getManagedDomain` (tenancy repository)

```typescript
export async function getManagedDomain(db: Database): Promise<{ id: string; name: string; status: string } | null> {
  const result = await db
    .prepare('SELECT id, name, status FROM managed_domains LIMIT 1')
    .first<{ id: string; name: string; status: string }>();
  return result ?? null;
}
```

### Dashboard link use case

```typescript
// modules/onboarding/cloudflare-dashboard-link.ts
const CLOUDFLARE_DASHBOARD_URL = 'https://dash.cloudflare.com';

export async function getCloudflareDashboardLink(): Promise<{ url: string }> {
  // Allowlisted URL — constructed server-side, not from user input (no open redirect).
  // TODO: construct account-specific deep link when account_id is available (system_settings).
  return { url: CLOUDFLARE_DASHBOARD_URL };
}
```

### Verify use case

```typescript
// modules/onboarding/cloudflare-verify.ts
export async function verifyCloudflareEmailRouting(
  input: { db: Database },
  deps: { clock: Clock },
): Promise<{ verified: true; domain: string }> {
  const domain = await getManagedDomain(input.db);
  if (!domain) {
    throw new DomainError({
      code: 'SETUP_DOMAIN_REQUIRED',
      message: 'A managed domain must be created before verifying Cloudflare',
      httpStatus: 409,
    });
  }

  // Advance step to 'inbound-smoke'
  const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
  await updateInstallationStep(input.db, 'inbound-smoke', now);

  return { verified: true, domain: domain.name };
}
```

### Route handlers

```typescript
routes.post('/cloudflare/dashboard-link', setupSession, async (c) => {
  const result = await getCloudflareDashboardLink();
  return c.json({ data: result });
});

routes.post('/cloudflare/verify', setupSession, async (c) => {
  const result = await verifyCloudflareEmailRouting(
    { db: c.env.DB },
    { clock: systemClock },
  );
  return c.json({ data: result });
});
```

### Test approach

Same pattern as domain tests: claim session → optionally seed domain → call endpoint → verify response + step.

## Decisions

1. **Verify is an operator-confirmation step.** No Cloudflare API call. The inbound smoke test
   (CAP-013) provides real verification. This is documented as a Phase 1 simplification.
2. **Dashboard URL is generic.** `https://dash.cloudflare.com` — no account-specific deep link.
   The operator navigates to Email Routing from there.
3. **No new contracts needed.** The request bodies are empty (POST with no body). The response
   shapes are simple enough to not need zod schemas.

## Open questions

(None.)
