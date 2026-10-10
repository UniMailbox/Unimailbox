# CAP-005 — Deploy to a fresh Cloudflare account with no manual `.env` edits

## Context

Phase 0 acceptance criterion: "Deploying to a fresh cloud account succeeds with no manual .env edits."

Today `apps/worker/wrangler.jsonc` ships with placeholder IDs (`REPLACE_WITH_D1_DATABASE_ID`,
`REPLACE_WITH_KV_SETUP_SESSION_ID`, `REPLACE_WITH_KV_CACHE_ID`,
`REPLACE_WITH_SECRETS_STORE_ID`). `wrangler deploy --dry-run` passes against placeholders;
real deploys need real resource IDs. CAP-005 builds the automation that closes that gap.

This is an **operator-action capability** — the deliverable is a deploy script and runbook.
The actual cloud deploy requires operator Cloudflare credentials and cannot run from this
session. The capability is `Implemented` when the script is complete, reviewed, and verified
as far as possible without cloud access. It becomes `Verified` when an operator runs it end-to-end.

## Acceptance criteria

1. `pnpm scaffold deploy` exists and is documented.
2. The script provisions all 6 Cloudflare resources idempotently: D1 database, R2 bucket,
   2× KV namespaces, Queue, Secrets Store.
3. The script generates or sets `INSTALLATION_TOKEN` (cryptographically random) and
   `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes for AES-256-GCM) in the Secrets Store.
4. The script resolves placeholder IDs in a **generated** `wrangler.resolved.jsonc`
   (gitignored) and deploys using `--config` against that file — **never modifies the
   committed `wrangler.jsonc`**.
5. The script runs remote migrations after deploy via `wrangler d1 execute --remote`.
6. The script verifies the deploy with a healthz check (HTTP GET on the deployed URL).
7. The script is idempotent: re-running detects existing resources (by name) and reuses
   them instead of erroring.
8. The script refuses to deploy if `ENVIRONMENT` is `local` or unset (same guard pattern
   as `db-migrate.ts --reset`).
9. Provisioned resource IDs persist to a gitignored `.cloudflare-resources.json` so re-runs
   can detect existing resources without re-listing everything.
10. `pnpm scaffold doctor` still exits 0.
11. `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:worker`, `pnpm build` all exit 0.
12. A unit test covers the config-resolution logic (placeholder → real ID substitution)
    and the ENVIRONMENT guard.
13. `docs/operations/deploy.md` runbook documents the operator steps: auth, first deploy,
    re-deploy, and what each secret is for.
14. `wrangler.jsonc` is **not** modified — it stays as the template with placeholders.
15. `wrangler.resolved.jsonc` and `.cloudflare-resources.json` are added to `.gitignore`.

## Scope — files this capability owns

| File | Action | Owner |
|---|---|---|
| `scripts/deploy.ts` | **create** | implementer |
| `scripts/scaffold.ts` | **edit** — add `deploy` subcommand | implementer |
| `scripts/deploy.test.ts` | **create** — unit test for config resolution + env guard | implementer |
| `docs/operations/deploy.md` | **create** — runbook | implementer |
| `.gitignore` | **edit** — add resolved config + resource state | implementer |
| `package.json` | **edit** — if a `deploy` script shortcut is needed | implementer |

## Files this capability must NOT touch

- `apps/worker/wrangler.jsonc` — stays as the template with placeholders
- `migrations/*` — CAP-004 owns these
- `apps/worker/src/**` — no worker source changes
- `packages/**` — no package changes
- `scripts/db-migrate.ts` — CAP-004 owns this
- `scripts/doctor.ts` — CAP-003 owns this (unless a deploy check is needed, then coordinate)

## Design constraints

### Config resolution approach

The committed `apps/worker/wrangler.jsonc` is a **template** with placeholder strings. The
deploy script:
1. Reads `apps/worker/wrangler.jsonc` as a string.
2. Replaces the four `REPLACE_WITH_*` placeholders with real resource IDs.
3. Writes the result to `apps/worker/.wrangler.resolved.jsonc` (gitignored).
4. Passes `--config apps/worker/.wrangler.resolved.jsonc` to every wrangler command that
   needs resource bindings.

**Never** modify the committed `wrangler.jsonc`. Never commit a resolved config.

### Wrangler CLI reference (verified against wrangler 4.121.0)

```
wrangler whoami                                    # auth check
wrangler d1 create unimailbox-db                   # creates D1, outputs JSON with uuid
wrangler d1 list --json                            # list existing D1 databases
wrangler r2 bucket create unimailbox-attachments   # creates R2 bucket
wrangler r2 bucket list                            # list existing buckets
wrangler kv namespace create SETUP_SESSION         # creates KV namespace, outputs JSON with id
wrangler kv namespace list                         # list existing KV namespaces
wrangler queues create unimailbox-outbound         # creates queue
wrangler queues list                               # list existing queues
wrangler secrets-store store create unimailbox-secrets   # creates Secrets Store, outputs JSON with id
wrangler secrets-store store list                        # list existing stores
wrangler secrets-store secret create <store-id> --name <name> --value <value> --scopes workers
```

All commands accept `--config <path>` and `--json` where output parsing is needed.

### Secret generation

- `INSTALLATION_TOKEN`: 32 bytes from `crypto.getRandomValues`, hex-encoded (64 chars).
  This is the token the operator uses to claim the installation via `POST /setup/claim`.
- `CREDENTIAL_ENCRYPTION_KEY`: 32 bytes from `crypto.getRandomValues`, hex-encoded.
  This is the AES-256-GCM key for encrypting provider credentials (ADR-007).

Both are generated on first deploy only. On re-deploy, if the secret already exists in the
store, the script skips creation and warns the operator. **Never overwrite an existing secret
without explicit `--force-secrets` flag.**

### ENVIRONMENT guard

Same pattern as `scripts/db-migrate.ts --reset`:
- `ENVIRONMENT` must be set to a non-`local` value (`preview`, `production`, etc.).
- If unset or `local`, the script exits 2 with a message.

### Idempotency

- Before creating each resource, check if it already exists by name.
  - D1: `wrangler d1 list --json` → find by name → reuse database_id
  - R2: `wrangler r2 bucket list` or just try-create (R2 create is idempotent)
  - KV: `wrangler kv namespace list` → find by title → reuse id
  - Queue: `wrangler queues list` → find by name
  - Secrets Store: `wrangler secrets-store store list` → find by name → reuse store_id
- If `.cloudflare-resources.json` exists, read it first as a fast path; fall back to
  listing if the file is stale (resource not found by stored ID).

### Healthz verification

After deploy, fetch `<worker-url>/healthz` and assert 200 + `{ ok: true }`.
The worker URL is printed by `wrangler deploy` output, or constructable as
`https://<worker-name>.<subdomain>.workers.dev` (if workers_dev) or the custom domain.

Since `workers_dev: false` in the current config, the script should extract the deployed
URL from `wrangler deploy` output or use `wrangler deployments list` to find it. If the
URL cannot be determined, warn and skip the healthz check with a clear message.

## Out of scope

- CI/CD pipeline (GitHub Actions, etc.) — future capability
- Custom domains / DNS — operator configures separately
- `wrangler dev` improvements — local dev already works
- Worker source changes — the stub handlers from CAP-001 are sufficient for deploy verification
- Multi-environment deploy (preview vs production) — single target for now; the script takes
  the target from `ENVIRONMENT`

## Reading list

- `.claude/rules/architecture.md` — platform shape, API conventions
- `.claude/rules/git.md` — commit conventions, what is committed
- `.claude/rules/coding.md` — TypeScript strict, no `any`, naming
- `.claude/rules/testing.md` — test levels, what must be tested, mocking rules
- `.claude/rules/security.md` — ADR-007 secret storage, secret generation
- `docs/rebuild/09-decisions/ADR-007-secret-storage.md` — Secrets Store design
- `docs/rebuild/08-roadmap/phase-0-foundation.md` — Phase 0 acceptance criteria
- `apps/worker/wrangler.jsonc` — the template config with placeholders
- `scripts/scaffold.ts` — the dispatcher to add the `deploy` subcommand to
- `scripts/db-migrate.ts` — reference for the ENVIRONMENT guard pattern and wrangler CLI usage
- `scripts/doctor.ts` — reference for structural check patterns

## Quality gates

```
pnpm scaffold doctor      # exits 0
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:worker
pnpm build
```

The deploy script itself cannot be tested end-to-end without cloud credentials. The unit
test covers the pure logic: config resolution (placeholder substitution), ENVIRONMENT guard,
and resource-state file read/write.
