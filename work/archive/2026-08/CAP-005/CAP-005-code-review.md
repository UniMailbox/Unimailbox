# CAP-005 — Code Review

**Reviewer:** code-reviewer · **Date:** 2026-08-12 · **Base:** `cap/CAP-005-deploy`

**Status:** REJECT

## Findings

### [BLOCKER] Dry-run poisons `.cloudflare-resources.json`

`setSecrets` flips `installationToken = true` / `credentialEncryptionKey = true` outside
the `if (dryRun)` blocks. Provisioners return `<dry-run-id>` into state. `saveResourceState`
is unconditional. Next real deploy: skips secret creation (flags already true), tries to
use fake IDs. Security-critical — CREDENTIAL_ENCRYPTION_KEY never written.

### [HIGH] D1 `create --json` not documented; field is `uuid` not `id`

`wrangler d1 create` does not document `--json`. D1 payload uses `uuid`, not `id`. First-
deploy D1 path fails either way.

### [HIGH] `parseWranglerList`/`parseWranglerSingle` envelope shape unverified

Assumes `[{ success, result: [...] }]` — inconsistent with db-migrate's `results` (plural).
Parse failures silently swallowed → breaks idempotency.

### [MEDIUM] Secret values via `--value` CLI flag

Wrangler docs mark as "Not secure." Visible in process lists.

### [MEDIUM] No test coverage for `setSecrets` branching

The three-way create/update/skip logic is untested.

### [MEDIUM] Healthz unbounded fetch + fragile body assertion

No timeout on `fetch`. Substring match on body. Dead code under `workers_dev: false`.

### [LOW] Main guard fragile

`import.meta.url === \`file://${process.argv[1]}\`` — use `pathToFileURL`.

### [LOW] Exit code inconsistency

Uses `process.exit(1)` where db-migrate uses `process.exit(r.status ?? 1)`.

### [LOW] Docs drift

Runbook says ">= 4.39.0", should be ">= 4.121.0". Troubleshooting message mismatch.

### [LOW] Minor smells

Mutation of state.secrets before spread, redundant annotation, source-grep test.

## Resolution

All findings addressed in fix-up pass 2 (`work/active/CAP-005-deploy/fix-up-2.md`).
Focused re-review ACCEPT with line-level evidence for every fix.
