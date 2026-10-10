# ADR-008 — Better Auth on Cloudflare D1

## Status

Accepted for CAP-042 with the Slice 0 decisions recorded in
`work/active/CAP-042-better-auth-shell/spike-evidence.md`. Registration cutover remains gated by
the named failure-injection Workers tests.

## Context

CAP-019 implemented email/password registration, login, refresh, and session lookup directly on
Cloudflare primitives:

- PBKDF2-SHA256 credentials live in four required columns on `users` (ADR-006).
- Short-lived bearer access tokens live in `CACHE` KV.
- Hashed refresh tokens live in the existing `sessions` D1 table.
- `authn` resolves a token to `userId`; the existing authorization and mailbox layers consume only
  that `userId`.

CAP-042 must add the real browser login/logout/session-recovery flow. We will use Better Auth for
that authentication boundary instead of extending the custom access/refresh-token system.

The Hono reference demonstrates creating an auth instance from the request environment and passing
Hono's raw `Request` to the Better Auth handler. Its database example is Neon/Postgres, while
Unimailbox uses D1/SQLite and repository-owned SQL migrations. The transport pattern is reusable;
the database and identity model are not.

## Decision

### Boundary and ownership

- Better Auth is confined to the HTTP/integration boundary. A request-scoped `createAuth(env)`
  factory constructs the D1 Drizzle adapter and Better Auth configuration.
- The identity module remains the owner of the canonical application user and RBAC relationships.
- A Better Auth session middleware resolves the cookie session, rejects non-active users, and sets
  the existing Hono `userId` variable. `requirePermission` and mailbox authorization continue to
  consume that variable unchanged.
- Better Auth response shapes are an explicit exception at the authentication endpoint boundary;
  domain APIs retain the Unimailbox response/error envelope.

### Dependency and runtime baseline

- CAP-042 starts with exact, matching dependency pins for `better-auth` and
  `@better-auth/drizzle-adapter`. The planning baseline is `1.7.1` for both; changing it before or
  during implementation requires rerunning the compatibility spike and recording the decision.
- The existing `drizzle-orm@0.45.2` is inside the adapter's supported peer range, so CAP-042 does
  not upgrade Drizzle merely to introduce Better Auth.
- The implementation must pass in the Cloudflare Workers Pool with real D1. A Node-only test or
  successful typecheck is not runtime evidence.

### Database ownership and model mapping

Repository SQL remains the deployment authority. Better Auth CLI/schema generation is used only to
derive and review the required shape; checked-in `migrations/*.sql` and matching `.verify.sql`
files apply it. Programmatic or remote schema mutation by Better Auth is forbidden.

The target mapping is:

| Better Auth model | D1 table | Decision |
|---|---|---|
| user | existing `users` | Reuse the canonical application ID and case-insensitive email |
| account | `auth_accounts` | New table; owns password credentials and future providers |
| session | `auth_sessions` | New table; do not collide with the legacy refresh-token table |
| verification | `auth_verifications` | New table; initially used only by enabled flows |

Before mapping Better Auth to `users`, the additive compatibility migration reconciles the
generated user fields with the existing schema. `name` maps to `display_name`; null/blank names are
backfilled and future writes receive a deterministic email-prefix fallback. `email_verified` and
`image` are added explicitly; application-only `status` remains owned by Unimailbox. A Drizzle
custom type bridges Better Auth `Date` values to the existing SQLite text timestamps; new auth
tables use generated integer epoch-millisecond timestamps. Legacy `password_*` columns are
retained through the dual-read period and are not dropped in CAP-042's initial migration.

### Credential and session migration

- Existing user IDs never change. Backfill is idempotent and produces one credential account per
  eligible password user, with count and orphan checks.
- Existing PBKDF2 parameters are encoded in a self-describing credential value. Better Auth's
  custom password `hash` and `verify` functions continue to enforce ADR-006, so existing users do
  not need an involuntary password reset.
- A later password-policy change is a separate ADR; adopting Better Auth does not silently replace
  PBKDF2 with its default password algorithm.
- Legacy bearer access tokens and refresh-token sessions are not converted. The controlled final
  cutover invalidates them and requires one login through Better Auth.
- D1 is the authoritative Better Auth session store. `CACHE` KV is not the primary session store
  because immediate logout, password-change revocation, and banned-user enforcement require
  authoritative reads. A namespaced Better Auth secondary store is a later measured optimization.

### Registration and setup administrator

Direct Better Auth sign-up remains disabled. The application owns the complete registration
invariant:

1. create the canonical user and credential account;
2. consume the invitation exactly once;
3. assign the default `member` role; and
4. leave no partial identity when any write fails.

The setup administrator path has the same obligation: it creates the Better Auth-compatible
credential without weakening the existing atomic setup-step transition. Roles are not seeded at
the administrator step; the existing setup-completion flow continues to batch the later
administrator-role assignment with the installation-complete state. Executable Workers evidence
shows that the adapter's `db.transaction()` path is unsupported by D1, so the adapter is configured
with `transaction: false`. The application prepares the canonical user, credential account, and
role/invite or setup-state statements and submits each required invariant in one D1 `DB.batch()`.
Better Auth reads the committed rows but does not own these multi-row writes. Failure-injection
tests remain the cutover gate; multiple independent writes may not be called atomic.

### Business-rule extensions

- The documented verified-email rule and `6..30` password bound remain authoritative; current
  CAP-019 `8..72` behavior and absent verification are implementation drift.
- Cookie session caching stays disabled. A session-update hook rotates the D1 session token on
  renewal, preserving R-AUTH-004.
- SQLite triggers enforce the ten-session cap atomically and revoke every session when a
  credential password changes. The session bridge rechecks canonical user status on every
  protected request.
- Registration enforces the configured email-prefix limit, invite-selected role, and guarded
  invite-use increment before its atomic batch can succeed.

### HTTP and browser session contract

- Better Auth first mounts under the non-conflicting shadow base path
  `/api/v1/auth/better/*`. The Hono mount path and Better Auth `basePath` must match exactly.
- After the legacy issuers are removed, the Better Auth base path may move to `/api/v1/auth` only
  in the same slice that updates the web client and route contracts.
- The final browser contract uses an HttpOnly session cookie. The web client sends credentials on
  same-origin requests and does not store access or refresh tokens in browser storage.
- `trustedOrigins` is explicit. Preview and production cookies are `Secure` and use the narrowest
  viable `SameSite` and domain scope. CSRF/origin checks stay enabled.
- `BETTER_AUTH_SECRET` is a new Secrets Store binding and is never derived from or aliased to
  `CREDENTIAL_ENCRYPTION_KEY`. `BETTER_AUTH_URL` and the migration mode are non-secret runtime
  configuration.
- During dual mode, a cookie principal and bearer principal that resolve to different user IDs
  produce 401. The system never chooses silently between conflicting identities.
- Raw Better Auth sign-in/session/sign-out endpoints do not inherit the application's generic
  mutation idempotency wrapper. Application-owned registration continues to enforce its existing
  idempotency contract.

### Rollout and rollback

CAP-042 uses `AUTH_PROVIDER=legacy|dual|better-auth`:

1. `legacy`: current bearer-token behavior only;
2. `dual`: shadow Better Auth endpoints and session bridge are available while legacy remains
   usable; and
3. `better-auth`: the browser and protected routes use Better Auth; legacy session issuance stops.

All pre-cutover migrations are additive. Rollback changes the provider mode and leaves the new auth
tables intact. Legacy tables and password columns are removed only in a later cleanup after preview
verification and an explicitly recorded retention window.

## CAP-042 decision gates

The compatibility spike may not close until it records a viable implementation or an explicit
contract conflict for:

- D1 adapter behavior and bundle/runtime compatibility in the Workers Pool;
- custom PBKDF2 verification for an existing user;
- registration and setup-administrator atomicity or an accepted durable compensation design;
- every `R-AUTH-001` through `R-AUTH-009` obligation, including the ten-session cap, renewal
  rotation semantics, revoke-all behavior, banned/deleted denial, email verification policy,
  password limits, and case-insensitive email; and
- the known difference between current CAP-019 behavior and rules that require verified email or
  different password bounds.

Browser traffic may not switch to Better Auth until tests establish:

- cookie attributes, trusted-origin/CSRF denial, logout revocation, and secret non-disclosure; and
- a deterministic conflict policy when legacy bearer and Better Auth cookie credentials coexist;
- the reconciled `R-AUTH-001` through `R-AUTH-009` behavior.

If Better Auth cannot satisfy an existing business rule through configuration or a bounded
extension, stop and amend the business decision explicitly; do not weaken the rule inside an
adapter.

## Consequences

### Positive

- CAP-042 gets a maintained authentication/session boundary without replacing domain identity or
  authorization.
- Existing user IDs, role assignments, mailbox ownership, and PBKDF2 credentials remain valid.
- Additive migrations and provider modes make the local integration reversible.

### Negative

- Dual mode temporarily maintains two session mechanisms.
- Reusing `users` requires a careful compatibility migration and generated-schema review.
- Registration and setup retain application-owned D1 batch orchestration.

## Alternatives considered

- **Copy the Hono Neon example unchanged:** rejected; it changes the database and migration
  authority.
- **Create a second Better Auth user table:** rejected as the default because it introduces an
  identity-linking layer between every auth user and existing RBAC/business foreign keys.
- **Reuse the existing `sessions` table:** rejected because its refresh-token schema is not the
  Better Auth session model.
- **Big-bang replacement:** rejected because it removes the rollback path and can lock out existing
  users.
- **KV as the authoritative session store:** rejected for the first cut because revocation and
  account-status enforcement require authoritative behavior.

## References

- Hono, "Better Auth on Cloudflare" (source pinned at
  `honojs/website@6b0692bcdbc4674d01723cb9754b8cf01222f2ef`,
  `examples/better-auth-on-cloudflare.md`, MIT):
  <https://hono.dev/examples/better-auth-on-cloudflare>
- Better Auth, "Drizzle ORM Adapter": <https://better-auth.com/docs/adapters/drizzle>
- Better Auth, "Database": <https://better-auth.com/docs/concepts/database>
- Better Auth, "Options": <https://better-auth.com/docs/reference/options>
- Better Auth, "Installation": <https://better-auth.com/docs/installation>
- Cloudflare, "Query D1 from Hono": <https://developers.cloudflare.com/d1/examples/d1-and-hono/>

These references are used as documentation and pattern guidance only; CAP-042 copies no upstream
code. If implementation adopts source code or a closely adapted structure, its active `task.md`
must first pin the upstream repository commit, exact files, and license per
`.claude/rules/reference-implementations.md`.
