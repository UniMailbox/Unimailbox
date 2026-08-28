# INV-003 — Preview resource mapping and next safe slice

**Owner:** Codex orchestrator  
**Date:** 2026-08-28  
**Mode:** read-only Cloudflare and repository investigation

## Question

Can the existing Cloudflare resources be mapped to the current Worker template so that the
CAP-054 preview verification can start, and what is the smallest follow-up implementation that
can proceed without creating or mutating remote resources?

## Repository state

- Branch: `master`; the root worktree is the only active workspace. The bounded resolver slice
  described below has now been implemented and is ready for commit review.
- HEAD: `f376ce6` (`fix(deploy): support current wrangler resource output`).
- No `.cloudflare-resources.json` or `apps/worker/.wrangler.resolved.jsonc` exists.
- `apps/worker/wrangler.jsonc` still contains local defaults (`ENVIRONMENT=local`,
  `BETTER_AUTH_URL=http://localhost`) and four resource-ID placeholders.
- `scripts/deploy.ts:evaluateDeployConfigForTarget` correctly refuses those local defaults for a
  non-local target. `resolveConfigTemplate` currently replaces resource IDs only; it does not
  generate target-specific `ENVIRONMENT` or `BETTER_AUTH_URL` values.

## Read-only account mapping

All commands used the authenticated Wrangler account and did not create, update, deploy, migrate,
read secret values, or inspect `.dev.vars`.

| Required binding | Existing resource | Result | Evidence / decision |
|---|---|---|---|
| `DB` | D1 `unimailbox`, UUID `7873409d-9010-41a9-8f40-7f03b82356f8` | Candidate only | `d1 info` reports 33 tables and a non-empty database. Remote `d1_migrations` contains only `0001`–`0009`; current repository migrations run through `0019`, and `auth_accounts`/`auth_sessions`/`auth_verifications` are absent. Treat as an older deployment and do not call it CAP-042-ready until pending migrations are deliberately applied. |
| `SETUP_SESSION` | KV `unimailbox`, ID `0ab92b59069443a490ec73d9271b96cd` | Unsafe to auto-map | Only one KV namespace exists, while the template declares two bindings. Setup sessions use raw token keys; `CACHE` uses `auth:` and `smoke:` prefixes. Reusing one namespace for both requires an explicit isolation decision and must not be guessed by the deployer. |
| `CACHE` | Same single KV candidate | Unsafe to auto-map | Same reason as `SETUP_SESSION`; no second namespace exists. |
| `OUTBOUND` | Queue `unimailbox-outbound` | Mappable | Exact queue exists with one producer and one consumer; its name matches the template. `unimailbox-outbound-dead` also exists but is not declared by the current template. |
| Secrets Store | `default_secrets_store`, ID `6e833ff48a204eca892bb07a863fa54a` | Store candidate only | Store exists. Listed names are `intstallation-token`, `auth-signing-key`, and `credential-key`; these do not match the four current bindings (`INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `CURSOR_SIGNING_KEY`). Values were not read. A deploy would create missing names, which is an external write requiring explicit operator approval. |
| `ATTACHMENTS` | R2 | Blocked | `wrangler r2 bucket list` fails with Cloudflare code `10042` (“enable R2 through Cloudflare Dashboard”). No bucket can be mapped or safely created from this session. |
| Worker preview endpoint | `unimailbox-worker` | Blocked | `wrangler deployments list --name unimailbox-worker --json` reports code `10007` (“This Worker does not exist”). No preview origin is available for `BETTER_AUTH_URL` or CAP-054 provider observation. |

## Decision

The existing account state is **not a complete resource mapping** for this repository. During this
local-only round, do not write a partial `.cloudflare-resources.json`, do not auto-bind the one KV
namespace to both roles, and do not run the deploy script: it would either attempt external
provisioning or stop at the target-config guard. A shared one-KV deployment remains an explicit
future decision, not an implicit discovery result.

CAP-054 remains locally implemented but preview/provider verification is blocked. CAP-047 remains a
dispatch candidate only; its business implementation must not be started until the CAP-054 preview
gate is restored, per `docs/rebuild/capability-ledger.md`.

## Operator decision — local first (2026-08-28)

The operator explicitly chose to defer deployment-resource changes:

- R2 stays disabled for now; no remote bucket is created or mapped.
- The eventual remote deployment will use one KV namespace. The two logical bindings remain in the
  local/test Wrangler topology for test isolation; they are not evidence that two remote namespaces
  must be provisioned. Before a one-namespace deployment, the setup-session key namespace must be
  made explicit and reviewed against the existing `auth:`/`smoke:` cache prefixes.
- D1 is updated locally first. The local runner reports `No pending migrations (19 already applied)`
  and all `0019` verify assertions pass (`19/19`). Remote D1 migration/deploy work is deferred.
- CAP-054 provider verification and CAP-047 dispatch remain deployment-gated and are not part of
  this local-only round.

## Smallest safe implementation slice

Before another deploy attempt, Claude Code may implement only target-value substitution in the
ignored generated Wrangler config:

1. Extend the pure config resolver so the generated config can set the requested target
   `ENVIRONMENT` and an explicitly supplied `BETTER_AUTH_URL`, while leaving the committed template
   unchanged.
2. Use JSON-safe escaping and preserve the existing non-local HTTPS guard; missing/HTTP origins
   must still fail closed.
3. Add pure tests for preview substitution, local-template preservation, and guard failures.

This slice must not change resource discovery, KV policy, R2 handling, migrations, secrets, Worker
routes, CAP-047 files, the ledger, or the implementation log. It also must not invoke a remote
write. Deployment follow-up now deliberately defers R2 enablement, one-KV isolation/mapping,
secret-name reconciliation, remote D1 migration, and the real HTTPS preview origin.

## Investigation disposition

The bounded target-value resolver slice is implemented in `scripts/deploy.ts` with focused tests in
`scripts/deploy.test.ts`; no resource discovery, KV policy, R2 handling, migrations, secrets,
Worker routes, CAP-047 files, ledger, or implementation-log changes were made by that slice. This
note is the durable Codex investigation record and handoff for the independent Grok validation.
