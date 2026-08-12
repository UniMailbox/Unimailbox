# CAP-005 — Architecture Review

**Reviewer:** architecture-reviewer (web-architect) · **Date:** 2026-08-12 · **Base:** `cap/CAP-005-deploy` (vs `cap/CAP-004-initial-schema`)

**Status:** ACCEPT WITH NOTES

## Summary

Architecturally sound. `scripts/deploy.ts` correctly stays in the operator-tooling layer — it imports only `node:` builtins and touches nothing in `apps/worker/src/**` or `packages/**`, so no `architecture.md` dependency-direction or bounded-context rule is engaged, let alone violated. The template + generated-resolved-config approach is the right shape, the committed `wrangler.jsonc` is provably unmodified, and "One Worker, multiple entrypoints" is respected. The single most important thing to fix is the idempotency path: the wrangler `--json` envelope assumption is unverified and inconsistent with `db-migrate.ts`, and the provisioners silently swallow list-parse failures, so a shape mismatch disables "find existing by name" with no diagnostic.

No BLOCKER. No architecture-rule violation. Findings are robustness/operational gaps concentrated in idempotency, which the capability's two-stage Implemented→Verified status already anticipates.

## Acceptance criteria — QA reviews only

Architecture review; not the QA pass. Not filled here.

## BLOCKER

> None. An empty BLOCKER section is the result here — nothing rises to a ship-stopping architecture-rule violation, data-loss path, or auth bypass in the architectural sense. (Secret-handling concerns are owned by the security review at `work/reviews/CAP-005-security-review.md`.)

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

### H1 — wrangler `--json` envelope assumption is inconsistent with db-migrate.ts and parse failures are silently swallowed

- **Where:** `scripts/deploy.ts:108-133` (`parseWranglerList`), used by every provisioner at `:201-209`, `:263-273`, `:301-310`, `:333-341`.
- **Violates:** No `architecture.md` rule directly; this is a soundness defect in the idempotency strategy the task contract (AC #7) requires. Inconsistent with the fail-closed parsing pattern CAP-004 established in `scripts/db-migrate.ts:197-220`.
- **Failure scenario:** `parseWranglerList` assumes the `--json` output is `[{ success, result: T[] }]` — singular `result`, reads only `parsed[0]`. `db-migrate.ts` established the wrangler batch shape as `[{ results: [...], success: true, meta }]` — plural `results`. Wrangler list subcommands (`d1 list`, `kv namespace list`, `queues list`, `secrets-store store list`) commonly return a plain array of objects with no success/result envelope. In that case every list call returns `{ ok: false }`. Each provisioner discards `{ ok: false }` with no log and falls straight through to `wrangler … create`. On a first deploy (nothing exists) this is harmless. On a re-deploy from a missing or stale `.cloudflare-resources.json` (different machine, file deleted, file present but a resource was deleted out-of-band), the script attempts to recreate resources that already exist and fails at `create` with a confusing "Failed to create…" error instead of reusing them or reporting that the list could not be parsed. Idempotency (AC #7) silently degrades; the operator gets a misleading message.
- **Fix:** (a) Verify the actual `--json` shape for each list subcommand at the first E2E run and align the parser (db-migrate's `results`-plural / iterate-all-batches shape is the established reference). (b) Stop swallowing parse failures: when `parseWranglerList` returns `{ ok: false }`, warn (or fail) with the error message so a shape mismatch is diagnosable, matching db-migrate's fail-closed pattern.

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — Stale state-file fast path never validates stored IDs

- **Where:** `scripts/deploy.ts:195-198` (D1), `:228-231` (R2), `:257-260` (KV), `:296-299` (Queue), `:328-330` (Secrets Store).
- **Violates:** task.md §Idempotency: "read it first as a fast path; fall back to listing if the resource is not found by stored ID." The contract's stated strategy is not implemented.
- **Failure scenario:** A resource is deleted out-of-band while `.cloudflare-resources.json` still holds its ID. The provisioner trusts `state.d1DatabaseId` (etc.), returns immediately, and the stale ID reaches `wrangler d1 execute --remote` / `wrangler deploy`, surfacing as an opaque migrate/deploy failure rather than re-provisioning.
- **Fix:** When reusing a stored ID, validate it still resolves (a single list/lookup); on miss, clear the stale entry and fall through to the existing-resource-by-name path.

### M2 — Remote-migration filename guard is weaker than the sibling script CAP-004 established

- **Where:** `scripts/deploy.ts:515`.
- **Violates:** Inconsistent application of the defense-in-depth invariant CAP-004 added at `scripts/db-migrate.ts:36,81-86` (`MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/` + `assertSafeMigrationName`, with an explicit comment that the guard exists because "a hostile PR or a misconfigured git mv could reintroduce a dangerous name").
- **Failure scenario:** deploy.ts filters `migrations/` with `/^\d{4}_/.test(f) && f.endsWith('.sql') && !f.includes('.verify.')` and passes the result to `wrangler d1 execute --file` against the **remote** database. The looser regex accepts names the CAP-004 path rejects. The same directory is consumed by both scripts; the remote path should not be less hardened than the local one.
- **Fix:** Reuse the same strict regex (and ideally the same helper) on both paths.

### M3 — `--force-secrets` relies on an unverified `secrets-store secret update` subcommand

- **Where:** `scripts/deploy.ts:397-402`, `:440-445`.
- **Violates:** No rule; the verb is absent from the task contract. task.md §Wrangler CLI reference documents only `secrets-store secret create`.
- **Failure scenario:** If `update` is not a valid wrangler 4.121.0 verb (or has a different argument shape), the entire `--force-secrets` path fails at runtime the first time an operator rotates secrets.
- **Fix:** Verify the verb at the first E2E run; if unavailable, implement force as delete + create.

### M4 — Healthz verification (AC #6) is effectively dead code under the committed config

- **Where:** `scripts/deploy.ts:536-579`, regex at `:550`.
- **Violates:** No rule; AC #6 is nominal only. `workers_dev: false` and no route/custom domain in `wrangler.jsonc` means `wrangler deploy` emits no `*.workers.dev` URL, so the regex never matches and the healthz branch is never entered — the script always lands in the "could not extract URL" warning (`:575-578`).
- **Failure scenario:** The health check the acceptance criterion names can never run with the current config. task.md §Healthz permitted warn-and-skip but also suggested `wrangler deployments list` as a URL source, which is not implemented.
- **Fix:** Either implement the `wrangler deployments list` fallback so the check is real once a route exists, or state the limitation explicitly in the runbook so AC #6 is not read as satisfied.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — R2 re-detection by substring match

- **Where:** `scripts/deploy.ts:243` — `listResult.stdout.includes('unimailbox-attachments')`.
- A substring test would also match a bucket named e.g. `unimailbox-attachments-archive`. Use `--json` and match the exact `name` field, as the other provisioners do.

### L2 — Multi-account deploy undocumented

- `wrangler.jsonc` carries no `account_id` by design; on a multi-account Cloudflare login, deploy needs `CLOUDFLARE_ACCOUNT_ID`. The runbook's Prerequisites section does not mention it.

## Not verified

- Every idempotency finding (H1, M1, M3) depends on wrangler's actual `--json` shapes and verb availability, which cannot be exercised without operator Cloudflare credentials. This is exactly the gap the capability's two-stage Implemented→Verified status is designed to absorb; the HIGH should be confirmed (and the silent-swallow fixed) at the E2E Verified gate.
- The end-to-end deploy, healthz against a real URL, and remote-migration application were not executed in this review (no cloud access). I confirmed only the in-repo gates: `vitest --project scripts` (12 pass), `pnpm typecheck`, `pnpm lint`, `pnpm test:worker` (15 pass), `pnpm build`.
- Secret-handling (CLI `--value` leakage, logging, key format) is owned by `work/reviews/CAP-005-security-review.md` and not re-litigated here.

## Required fixes

1. H1 — Stop swallowing list-parse failures in the provisioners; verify and align the wrangler `--json` envelope shape at E2E.
2. M2 — Apply the same strict migration-filename guard CAP-004 uses, on the remote path.

Deferred (acceptable with a ledger note + runbook update, resolve at the Verified gate): M1 (stale-state validation), M3 (verify `secrets-store secret update`), M4 (healthz reachability). L1/L2 are cheap cleanups.

---

## Notes for the orchestrator

- Layering is clean. Verified: `scripts/deploy.ts` imports only `node:child_process`, `node:fs`, `node:path`, `node:url` — no import from `apps/worker/src/**` or `packages/**`. Operator tooling sits outside the Worker's `entrypoints → modules → domain` graph, so `architecture.md`'s dependency-direction and bounded-context rules are not engaged.
- Template + resolved config is sound: `apps/worker/wrangler.jsonc` is byte-for-byte unmodified (`git diff cap/CAP-004-initial-schema -- apps/worker/wrangler.jsonc` is empty); `.wrangler.resolved.jsonc` and `.cloudflare-resources.json` are both gitignored (`.gitignore` lines for `/apps/worker/.wrangler.resolved.jsonc` and `/.cloudflare-resources.json`).
- "One Worker, multiple entrypoints" respected — the script deploys the single configured worker and does not alter the entrypoint model.
- The `scripts` vitest project (`scripts/vitest.config.ts`) matches the existing per-package config pattern and is correctly wired into the root `vitest.config.ts` projects list; it runs in the node pool and is included in `pnpm test:unit` (project name `scripts` passes the `--project '!workers'` filter).
- ENVIRONMENT guard and secret-generation (ADR-007: 32 random bytes, hex, `crypto.getRandomValues`) match the established patterns.
