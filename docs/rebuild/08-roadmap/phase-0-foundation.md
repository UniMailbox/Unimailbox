# Phase 0 — Foundation

See `../H-progressive-rebuild-roadmap.md` for the high-level summary.

## Business goal

A fresh cloud account can deploy the new system with zero `.env` edits. Setup is gated by a token. The admin can land on `/setup`.

## User value

None directly. This phase exists to lay the rails.

## Scope

- New repo (greenfield). No code carried over from the existing `mail-worker/`, `mail-vue/`, or `mail-react/`.
- Monorepo workspace (`apps/worker`, `apps/web`, `packages/contracts`, `packages/email-core`, `packages/config`, `packages/test-kit`).
- Worker entrypoints: `http`, `inbound-email`, `queue`, `scheduled`.
- Hono router with `/api/v1` and `/setup/*` routes.
- Drizzle schema for: `installation_state`, `system_settings`, `users`, `sessions`, `encrypted_credentials`, `permissions`, `roles`, `role_permissions`, `user_roles`, `audit_events`, `maintenance_jobs`.
- Migration CLI (`pnpm scaffold init`, `pnpm scaffold db:migrate`).
- Wrangler config with auto-provisioned bindings.
- Web client (React + shadcn/ui + TanStack Query) with router and design tokens (matches `DESIGN.md` of the legacy repo).
- Setup wizard step 1 (`claim`) and step 2 (`preflight`) only.
- Setup-route guard: all non-setup routes 302 to `/setup` while `installation_state.status ≠ 'complete'`.
- Structured logger; error model; UUID generator; clock.
- Encrypted credential store (AES-GCM, key from Secrets Store).
- `pnpm test:unit`, `pnpm test:worker`, `pnpm scaffold doctor` all green.

## Out of scope

User-facing routes, message lifecycle, providers.

## Acceptance criteria

```text
[x] pnpm install works from a clean checkout of the new repo.
[x] pnpm scaffold doctor exits 0.
[x] pnpm test:unit passes.
[x] pnpm test:worker passes.
[x] pnpm build produces a deployable Worker + web client bundle.
[x] Deploying to a fresh cloud account succeeds with no manual .env edits.
[x] First GET / returns 302 to /setup.
[x] /setup/status returns { currentStep: 'claim' } on a fresh DB.
[x] /setup/claim with the correct INSTALLATION_TOKEN binds a setup session.
[x] /setup/claim with the wrong token returns 401.
[x] /setup/preflight reports each binding present.
```

## Key technical decisions

- **Wrangler version**: pin `4.39.0` or later (auto-provisioning stable).
- **Secrets Store**: use `wrangler.jsonc` `secrets_store_secrets` declarations.
- **PBKDF2 iterations**: 600_000.
- **Migration runner**: Wrangler native + Drizzle Kit for type generation.
- **Setup session TTL**: 30 minutes; one-time consumption.

## Migration from legacy

- The new repo runs on a **separate route** (preview deployment).
- The legacy system continues serving production on its own route.
- No data migration in Phase 0.
- No code is shared.

## Risks

- Wrangler auto-provisioning may not provision Secrets Store (verify in preview).
- Setup state machine optimistic concurrency needs thorough testing.

## Tests required

- Vitest unit tests for crypto, errors, clock.
- Worker-pool tests for the setup-state machine.
- Doctor checks: bindings declared, schema in sync, no missing migrations.