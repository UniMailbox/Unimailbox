# CAP-042 Slice 0 — Better Auth / D1 compatibility evidence

**Owner:** main Codex orchestrator
**Date:** 2026-08-22
**Runtime under test:** Cloudflare Workers Pool with the repository's real D1 binding

This document records the investigation decisions. Claude Code and Grok do not own these
decisions; they receive only bounded implementation or review tasks derived from them.

## Pinned dependency baseline

Registry metadata inspected on 2026-08-22:

| Package | Exact version | Relevant compatibility |
|---|---:|---|
| `better-auth` | `1.7.1` | MIT; repository `better-auth/better-auth`, package `packages/better-auth` |
| `@better-auth/drizzle-adapter` | `1.7.1` | MIT; peer `drizzle-orm ^0.45.2 or >=1.0.0-rc.1 <2`; peer `@better-auth/core ^1.7.1` |
| `drizzle-orm` | existing `0.45.2` | Satisfies the adapter peer range; no upgrade is needed |

The two Better Auth packages must remain exact and matching. A version change reopens this spike.

## Generated SQLite schema comparison

`pnpm dlx auth@1.7.1 generate` was run in an isolated temporary directory against a minimal
email/password configuration. It generated four models:

- `user`: required `id`, `name`, `email`, `email_verified`, `created_at`, and `updated_at`; optional
  `image`; SQLite dates use integer epoch milliseconds.
- `account`: required `issuer`, `account_id`, `provider_id`, `user_id`, `created_at`, and
  `updated_at`; optional `password` and OAuth material; unique `(issuer, account_id)` and indexed
  `user_id`.
- `session`: required unique `token`, `user_id`, `expires_at`, `created_at`, and `updated_at`;
  optional IP/user-agent; indexed `user_id`.
- `verification`: required `identifier`, `value`, `expires_at`, `created_at`, and `updated_at`;
  indexed `identifier`.

The generated shape cannot be applied unchanged:

- canonical `users` already owns the stable ID, case-insensitive email, status, RBAC references,
  and required ADR-006 password columns;
- legacy `sessions` has an incompatible refresh-token shape;
- canonical user timestamps are SQLite text while generated auth-table timestamps are epoch
  milliseconds; and
- `display_name` is nullable although Better Auth requires `name`.

Decision:

1. Map Better Auth `user` to existing `users`; map `name` to `display_name` and add
   `email_verified` plus `image`.
2. Backfill every null/blank `display_name` deterministically from the email prefix and make all
   application user writers supply the same fallback. The deployable migration enforces the
   non-null mapping with insert/update triggers rather than rebuilding the referenced `users`
   table.
3. Declare the existing text timestamps through a Drizzle custom type that converts `Date` to an
   ISO SQLite text value on input and back to `Date` on output. New auth tables use the generated
   integer epoch-millisecond representation.
4. Create `auth_accounts`, `auth_sessions`, and `auth_verifications`. Do not reuse legacy
   `sessions`, create a second user identity, or let a schema CLI mutate an authoritative DB.
5. Disable Better Auth's direct sign-up path. The application remains the sole user writer.

## D1 transaction and atomic registration result

A temporary Workers Pool test called `drizzle(env.DB).transaction(...)` against the real test D1
binding. Workerd rejected Drizzle's SQL transaction with:

> D1_ERROR: To execute a transaction, please use the state.storage.transaction() or
> state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT
> statements.

The published `@better-auth/drizzle-adapter@1.7.1` source implements `transaction: true` by calling
`db.transaction(...)`; Better Auth 1.7's upgrade guidance also identifies Cloudflare D1 as unable
to provide that transaction behavior. Therefore the production adapter must use
`transaction: false`.

No compensation workflow is required. Registration/setup remain application-owned and prepare all
statements before one D1 `DB.batch()`:

- invite registration: canonical `users` row + `auth_accounts` credential row + selected invite
  role + guarded invite-use increment;
- setup administrator creation: canonical `users` row + `auth_accounts` credential row +
  installation-step transition. The roles do not exist yet at that setup step. Existing
  `completeSetup` remains responsible for the later administrator-role + installation-complete
  batch after it idempotently seeds roles and permissions.

The credential row is Better Auth-compatible: `provider_id = 'credential'`,
`issuer = 'local:credential'`, `account_id = users.id`, and `user_id = users.id`. Its password is a
self-describing ADR-006 PBKDF2 envelope. Better Auth reads it later; Better Auth does not perform
the multi-row write. Failure-injection tests must prove the whole batch rolls back.

The current invite route also has two defects that the cutover must close: it ignores the invite's
`role_id` in favor of the hard-coded member role, and the usage increment can exceed `max_uses`.
The atomic cutover reads `role_id` and uses `role_id ?? member`; a repository migration adds a
SQLite `BEFORE UPDATE OF used_count` trigger whose `RAISE(ABORT)` converts overuse into an in-batch
failure. A zero-row guarded UPDATE is explicitly rejected as a design because D1 would still
commit the other batch statements.

## R-AUTH reconciliation

The business-rule document remains authoritative where CAP-019 drifted; Better Auth defaults do
not amend it.

| Rule | Decision / extension | Required evidence |
|---|---|---|
| `R-AUTH-001` | Add `email_verified`; configure credential login to require verification. New and existing users start unverified unless evidence already exists. Setup can finish under its setup token; after outbound mail is configured, login/registration sends the verification flow. | Unverified denial, verified success, verification token expiry/reuse tests |
| `R-AUTH-002` | A session-create hook checks canonical `users.status = 'active'`; the Hono bridge rechecks status on every protected request. | banned/deleted login and existing-session denial tests |
| `R-AUTH-003` | An `auth_sessions` insert trigger atomically keeps the newest ten rows per user, ordered by `created_at DESC, id DESC`. | 11th-session deterministic eviction and concurrent creation tests |
| `R-AUTH-004` | Cookie cache stays disabled. A session-update hook replaces the session token whenever Better Auth renews the D1 session; Better Auth then signs the new token into the cookie. | old token denied/new token accepted after renewal |
| `R-AUTH-005` | An `auth_accounts` password-update trigger deletes all `auth_sessions` for that user in the same SQLite statement transaction. | change/reset revokes current and other sessions |
| `R-AUTH-006` | No social providers are configured. Only a credential account with a password is eligible for password login. | account-without-password denial |
| `R-AUTH-007` | The documented `6..30` bound is authoritative; current `8..72` schemas are implementation drift and must be corrected in shared contracts plus server/client tests. | 5/6/30/31 boundary tests |
| `R-AUTH-008` | Application-owned registration reads `minEmailPrefix` and rejects shorter prefixes before preparing its batch. | configured boundary tests |
| `R-AUTH-009` | Canonical `users.email COLLATE NOCASE` remains the unique lookup source; input is normalized to lower case before write/login. | mixed-case duplicate and login tests |

## Cookie, origin, secret, and runtime decisions

- `nodejs_compat` is already enabled in both Worker configurations.
- Better Auth 1.7.1 defaults its session cookie to `HttpOnly`, `SameSite=Lax`, path `/`, and adds
  `Secure`/the secure prefix for an HTTPS base URL. CAP-042 will configure these explicitly and
  keep the cookie host-only; cross-subdomain cookies are unnecessary for the single Worker/SPA.
- Better Auth's origin middleware validates form/origin/callback inputs against `trustedOrigins`.
  CAP-042 supplies exact same-origin local/preview/production values and does not enable origin or
  CSRF bypass options.
- Session cookie cache remains disabled so D1 revocation, status checks, and token rotation are
  authoritative on every protected request.
- `BETTER_AUTH_SECRET` is a distinct `SecretsStoreSecret`; the existing async `readSecret()` helper
  already supports production Secrets Store bindings and plain Worker-test vars.

## Reference provenance

| Source | Pin / license | Inspected use |
|---|---|---|
| Hono website | `honojs/website@6b0692bcdbc4674d01723cb9754b8cf01222f2ef`, `examples/better-auth-on-cloudflare.md`, MIT | Adopt only request-scoped factory, matching base path, and raw `c.req.raw` handler shape |
| Linked sample repository | `bytaesu/cloudflare-auth-worker@7cb28e1e22a76697d96f845e83ccdb4bb6e5cb4b`; no license file detected | Inspect only; copy/adaptation forbidden |
| Better Auth | `better-auth/better-auth`, published `1.7.1`, MIT; core DB schema/session routes and Drizzle adapter | Derive exact schema/adapter/session behavior; implementation uses public APIs |

The Hono example's Neon/Postgres database, broad `/api/*` mount, CLI migration workflow, and secret
file/deploy examples are rejected for this repository.

## Executable Slice 0 results

1. `better-auth-d1.spike.worker.test.ts`: 2/2 in Workers Pool — raw sign-up/session Request path and
   executable D1 transaction rejection. Grok found two schema-fidelity HIGHs; both were fixed and
   re-review accepted.
2. `password.worker.test.ts`: 27/27 in Workers Pool — canonical ADR-006 envelope, exact Better Auth
   1.7.1 callback type, correct/wrong password, and fail-closed malformed inputs. Grok found the
   positional `hash(password)` BLOCKER; it was fixed and re-review accepted.
3. `atomic-registration.spike.worker.test.ts`: 6/6 in Workers Pool — selected/null role, successful
   invite/setup batches, generic failure rollback, and exhausted-invite trigger rollback. Grok
   found three HIGHs in the first harness; the replacement closed all three and re-review accepted.

No Slice 0 BLOCKER or HIGH remains. These spike artifacts do not make a production route reachable;
the next slice moves their accepted shapes into repository-owned migration/runtime surfaces.
