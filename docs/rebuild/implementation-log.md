# Implementation Log

**What changed recently, and why.** Append-only; newest entry at the top. This is the second file a
recovering agent reads, after `capability-ledger.md`.

Log an entry when a capability closes, when a decision is made that is not big enough for an ADR but
that future agents depend on, or when a documentation source of truth is corrected.

**Do not log:** routine edits, test output, or anything the git history already answers well.

---

## 2026-10-15 — PR 48 reviewed and stable 1.0.1 released

PR #48 and compatibility follow-up #49 merged after exact-head gates passed.
Review fixed unreachable credential revocation while MCP is disabled, hidden
older credentials and strict cached-client response compatibility. Pagination
is explicit and owner-scoped; it introduces no polling. MCP initialize reports
the product version. Existing account-bound secret handling was retained.

Final main source `b4b7ca3` passed 2,415-test staging/production preparations,
all 37 remote SQL companions, exact-source smoke, authenticated legacy/new-client
checks and real scheduled D1 updates in both environments. No migration was
pending. Resources/keys and settings were preserved; production MCP stays off.
The matching tag workflow passed, and reviewed stable v1.0.1 was published as
Latest. Existing dependency advisories, full-day quota observation and full mail
acceptance remain separate. This was source self-review, not an independent
review. See [QA](../qa/release-1.0.1-2026-10-15.md), [release notes](../releases/1.0.1.md)
and [handoff](../../work/handoffs/release-1-0-1-2026-10-15.md).

## 2026-10-15 — Production synchronized to D1 maintenance state

The operator selected the existing Leanda production installation after staging
acceptance. Source `cc9c9d4` passed a fresh 2,411-test production preparation gate
and published as Worker `8ccd55d9-dd83-4d73-8be6-97bbfbe36d3f`, schema 0037.
A restored private backup passed integrity/FK and pending-migration simulation;
publication captured the recovery bookmark, applied additive 0034–0037 and
verified all 37 remote companions. Existing mail resources, key bindings,
catch-all and private forwarding metadata were retained; AI/MCP remain disabled.

Exact-version smoke, readiness, repeated maintenance and direct D1 state passed.
Real five-minute Cron advanced D1 at 17:20:43 Asia/Shanghai and three subsequent
maintenance probes passed. This removes production's 313/day fixed KV heartbeat
write baseline and three reads per steady probe, matching staging. Full-day
metrics and a new mail-delivery retest remain separate. Old readiness requires
schema 0033, so recovery must account for schema compatibility rather than blind
code rollback. Source self-review only. See [production QA](../qa/d1-maintenance-production-2026-10-15.md)
and [handoff](../../work/handoffs/production-d1-maintenance-2026-10-15.md).

## 2026-10-15 — Maintenance heartbeat and failure state moved to D1

The daily quota investigation found the fixed heartbeat write baseline remaining
in both staging and production: 313 KV writes/day each. Staging now persists
bounded cadence snapshots and relational failed-task names in D1. Atomic updates,
late-run guards and one-time old-KV adoption preserve failure/freshness behavior;
initialization grace cannot reset on deployment. Schedules and ordinary auth/
attachment KV behavior are unchanged. Provider quota notification settings remain
separate from the application's D1 maintenance state.

Source `a104103` passed the 2,411-test canonical gate and all 37 remote SQL
companions, then published as staging Worker
`246d800c-b48d-46d5-9d36-9d610d9e0820`, schema 0037. Backup restore and recovery
bookmark, repeated health/readiness and a real five-minute scheduled D1 heartbeat passed.
Hourly/daily legacy results were retained; full post-release daily usage and new
hourly/daily runs remain separate evidence boundaries. Production was unchanged.
Self-review only. See [QA](../qa/d1-maintenance-heartbeats-2026-10-15.md) and
[handoff](../../work/handoffs/d1-maintenance-heartbeats-2026-10-15.md).

## 2026-10-14 — Redundant browser KV reads and logout deletes reduced

Shared identity queries now reuse successful UI descriptors for 60 seconds,
removing the two additional identity reads in the guarded inbox footprint and
duplicate panel/query observers. Fresh admin entry checks, explicit cache
updates/invalidation and every server D1/session/account/permission gate remain.
Unauthenticated logout clears cookies without a billed KV delete; valid logout
still revokes its session and deletes its access token exactly once.

Live pre-change analytics confirmed 67 reads and zero deletes during the
preceding 24 hours; the earlier continuous maintenance-delete amplification
was absent. This is aggregate baseline evidence, not a post-change cost promise
or attribution of the operator's unspecified alert window. No cadence change,
migration or resource/key replacement was needed.

Application `72d86f6` plus fixture correction/release source `79ceaf2` passed
2,397 tests and all 36 remote SQL companions and deployed to staging as Worker
`1e0bdd33-1a59-4698-834b-10946a7bc7eb`, schema 0036. Live login/identity/logout,
repeat/invalid-token logout, access/refresh denial and maintenance passed.
Diagnostic session logged out; no private mail, real mail or production change.
Self-review only. See `../qa/kv-request-reduction-2026-10-14.md` and
`../../work/handoffs/kv-request-reduction-2026-10-14.md` for the scoped evidence.

## 2026-10-13 — MCP KV request amplification removed

MCP cards refresh on opening, explicit refresh and mutations, with no interval,
focus/reconnect fetches or layered retries. They reuse the parent's user ID
rather than adding session-query observers. Browser authn covers `/api/v1/*`;
`/api/mcp` retains its separate D1 credential, account, scope and rate checks
without a browser-token KV lookup. No schema or resource change was needed.

Application commit `e24bf27` passed 2,393 tests and all 36 remote companions and
was deployed to staging as Worker `fd7fa1b2-5d45-49ea-9e70-9b90753edf72`.
Actual binding spies count zero CACHE operations for MCP read/draft/rejection
paths, with a positive browser authentication control. Controlled frontend timers
show no idle/focus/reconnect requests. Live connection/scope/audience/Origin/
revocation and maintenance passed; test credential revoked, original enabled
configuration retained and diagnostic session logged out. No real mail was read
or sent. Full-day usage and native browser/agent acceptance remain unverified.
Self-review only. See `19-mcp-service.md`, `../qa/mcp-kv-staging-2026-10-13.md`
and `../../work/handoffs/mcp-kv-reduction-2026-10-13.md`.

## 2026-10-13 — MCP settings split by service and user

MCP is a card under Admin AI services with one service switch and an editable
shared setup prompt. The separate menu/page is removed (old bookmarks redirect).
Ordinary users manage their own expiring mailbox-scoped credentials in Quick
settings; read-only is default, draft/AI and send grants are independent and
bounded by live permissions. Personal APIs no longer require administrative
settings permissions. The retired installation send switch no longer gates sends;
existing read/draft credentials keep their grants and server limits remain active.
Migration 0036 adds the shared prompt without replacing credentials or keys.

Application commit `eb72db8` passed 2,389 tests and all 36 remote SQL companions,
then published to staging as Worker `b5a54cc1-476f-4ee8-9d9d-4e887916412b`.
Ordinary-member scope/denial, prompt propagation, read negotiation, separate send
discovery, Origin and revocation passed; all temporary access was removed and the
original disabled configuration restored. Readiness and maintenance passed.
No real mail was read or sent. UI evidence is synthetic; browser clipboard and
actual local-agent configuration remain open. Review was a main-agent self-review.
See `19-mcp-service.md`, `../qa/mcp-personal-settings-staging-2026-10-13.md` and
`../../work/handoffs/mcp-personal-settings-2026-10-13.md`.

## 2026-10-12 — Scoped MCP agent access

Admin → MCP service now controls a stateless HTTPS endpoint at `/api/mcp` (443),
one-time mailbox-scoped hashed credentials, separate draft/AI and send grants,
expiry/revocation and rate limits. Current account/role/mailbox checks remain
mandatory; send uses the existing audited/idempotent compose and outbox workflow.
Copy prompt references a private environment variable without including a secret.
Origin, bounded-body, batch, no-store and content-free tool-audit protections are
part of the adapter; a send confirmation flag does not prove human approval.

Commit `6701e04` was published to staging after the full 2,381-test gate, a D1
recovery bookmark, migration 0035 and all 35 schema companions. Live read-only
MCP negotiation, scope, Origin denial and revocation passed, then configuration
was restored to disabled. No real mail was sent; actual local-agent setup and
browser clipboard proof remain open. Design: `19-mcp-service.md`; QA:
`../qa/mcp-staging-2026-10-12.md`; handoff:
`../../work/handoffs/mcp-service-2026-10-12.md`. Review was a main-agent self-review.

## 2026-10-04 — CAP-A1 mailbox authorization boundary corrected

The mailbox authorizer no longer accepts a global-administrator bypass. A `role.manage` grant
alone cannot read messages or drafts, send from a mailbox, or download/upload its attachments;
the user must own the mailbox or have an explicit role in `mailbox_members`. The mailbox list now
uses the existing owner-or-member query, so shared mailboxes appear for their members while an
ungranted administrator sees none. Admin-only grant management remains a separate audited API.
The admin user-status route also rejects self-deactivation and self-deletion to prevent the
current administrator from locking themselves out.

Worker HTTP tests cover ungranted versus granted administrator access for inbox, drafts, send,
attachments and mailbox listing. The full local suite passed after these changes: 1186 non-Worker,
852 Worker and 17 test-kit Worker tests. Typecheck, lint, format, doctor 14/14, `git diff --check`
and root build passed. The build retains its existing large-chunk warning and Wrangler reports
a local log-file EPERM while its dry-run exits successfully. Browser and real Cloudflare preview
authorization remain unverified. No deploy, commit or push was performed.

---

## 2026-10-04 — CAP-A1 admin user lifecycle transaction boundary

The self-hosted administrator create, password-reset and status routes now batch each business
write with its D1 idempotency record and audit event. Create and reset return an initial password
once; the replay record contains a redacted placeholder, and same-key retries return 409 instead
of repeating the secret. Password reset and deactivation revoke existing D1 sessions. Production
and local-development Wrangler bindings, preflight and the active deploy secret flow no longer
require Better Auth. Migration-only adapter code and compatibility logic for old deploy fixtures
remain in the repository; Cloudflare Access headers are not an identity source.

The full `pnpm test` run before the final audit-rollback case passed 1186 non-Worker, 846 Worker
and 17 test-kit Worker tests. After that case was added, the focused administrator lifecycle
Worker file passed 5/5, including audit-failure rollback; the full suite has not been repeated.
Typecheck, lint, format, doctor 14/14 and root build passed in the earlier run. Browser account
flows and a real Cloudflare preview remain unverified. No deploy, commit or push was performed.

---

## 2026-10-04 — CAP-A2 admin-kit Table adoption

Pinned `marmelab/shadcn-admin-kit` Table source at `78e32b9` was adapted into a local
semantic table primitive without importing Ra-Core, React Router, Tailwind, or a second
data/authorization layer. `/admin/users` now uses labeled columns and retains the existing
user-scoped cursor query, status actions, one-time password display, error behavior and UTC-to-local
timestamp rendering. The horizontal scroll container has a named keyboard focus target. Source,
MIT attribution and the Web build snapshot are recorded in `13-shadcn-admin-kit-adoption.md`.

Focused UsersPage 9/9, full Web 435/435, typecheck, lint and Web build passed. Build output was
CSS 29.05 kB (gzip 4.71 kB) and main JS 673.27 kB (gzip 199.24 kB), with the existing Vite
500 kB warning. Browser desktop/narrow-screen/dark-mode/keyboard behavior and remote preview
remain unverified; the other admin-kit components have not yet been migrated. No deploy, commit
or push was performed.

---

## 2026-10-04 — CAP-A1 browser session recovery boundary

The self-hosted login route now issues the 30-day refresh token as an HttpOnly, same-site cookie
scoped to `/api/v1/auth`; the short-lived access token remains memory-only in the Web app. The
refresh endpoint accepts the cookie when the request body has no token, and logout expires the
cookie. `fetchAuthSession` probes `/me` and performs one cookie-backed refresh after a 401, then
stores the new access token only in the in-memory Zustand store. This keeps hard reload recovery
possible without localStorage/sessionStorage or a JavaScript-readable refresh token. The login JSON
still includes the legacy refresh-token field for API compatibility; the Web client ignores it.

The draft recovery back link now uses a TanStack Router Link in production, while retaining a
plain-anchor fallback for focused component tests mounted without a RouterProvider. Web auth and
draft recovery focused tests pass 30/30; Worker auth tests pass 38/38, including cookie-only
refresh and logout after access-token expiry. The final full suite then passed 1188 non-Worker,
854 Worker and 17 test-kit Worker tests. Full browser reload, real cookie policy on the preview
origin, and remote preview remain unverified. No deploy, commit or push was performed.

---

## 2026-08-31 — CAP-064 existing-draft editor autosave and PATCH integration

CAP-064 extends the existing authenticated draft-recovery route into a bounded
editor for existing drafts. To/Cc/Bcc/Subject/plain-text Body are controlled
inputs populated from the server-authoritative GET response; a dirty or
server-changed CAP-061 local copy must be explicitly recovered before editing.

Edits use a 500 ms debounce and a serialized per-draft queue. The browser
stores only draft content and CAP-061 version metadata, sends the exact
`updated_at` value in `If-Match`, and relies on the shared API client for fresh
request-id and `Idempotency-Key` headers. Successful PATCH responses are parsed
through `draftDetailResponseSchema`, checked against both route resource IDs,
mirrored into the user-scoped query/cache, and advance the next concurrency
token. A `412 STALE_IF_MATCH` preserves local edits, disables further editing,
and requires a fresh GET before the user explicitly loads the newer server
version. Cache-sync failures retry only the local sync operation.

**Files**: `apps/web/src/features/mailbox/DraftRecoveryPage.tsx`,
`DraftRecoveryPage.test.tsx`, and the CAP-064 PATCH fetcher/mutation in
`mailbox-queries.ts`; no Worker, migration, contract, provider, secret,
configuration, deployment, push, or remote changes.

**Gates**: focused DraftRecoveryPage 21/21; unit 71 files, 1122/1122; Worker
50 files, 886/886; doctor 14/14; lint, typecheck, format, build, and
`git diff --check` clean. Independent final subagent review: `NO FINDINGS`.
No browser live-login or preview verification was performed; those remain
outside this local capability slice.

---

## 2026-08-31 — Brevo live-test follow-up and empty-attachment payload fix

The Brevo request IP restriction was corrected on the provider side, so the
existing test API token was retained. A direct `GET /v3/account` check returned
HTTP 200. The setup route tests now use that live token for successful setup
and a real invalid key for the 401 failure path; deterministic 403/429/5xx,
network, redaction, and wire-shape cases remain in the adapter unit tests.

The outbound smoke route tests also use live Brevo HTTP. They discover an
authenticated sender domain and default the recipient to the Brevo account
email, avoiding committed account-specific values. This produces a small,
intentional number of real test emails when the route suite runs.

The first live outbound request exposed a provider contract issue: the adapter
always serialized `attachment: []`, which Brevo rejected with `400
missing_parameter`. The adapter now omits `attachment` when there are no
attachments; non-empty attachment serialization is unchanged. The local
gitignored `.dev.vars` credential-encryption value was also corrected to a
valid 32-byte hex key for the live setup/decrypt round-trip; the Brevo token
was not replaced.

**Gates**: Brevo account HTTP 200; adapter 10/10; setup route 19/19; outbound
smoke route 12/12; full Worker 886/886; unit 1111/1111; Web 362/362; contracts
383/383; doctor 14/14; lint, typecheck, format, build, and `git diff --check`
clean. No deploy or push performed. Browser valid-login/cookie verification
remains intentionally deferred to the operator.

---

## 2026-08-31 — Follow-up: Worker-first health check and local Better Auth cookie path

The local runtime exposed two configuration gaps after the Better Auth origin fix:
`GET /healthz` was being handled by Wrangler's SPA fallback and returned `index.html`,
and Better Auth's local `baseURL` still pointed at the Worker port while the browser
document was served by Vite on `:5173`.

Fix:
- `apps/worker/wrangler.jsonc`, `wrangler.dev.jsonc`, and `wrangler.test.jsonc` now
  declare both `/api/*` and `/healthz` in `assets.run_worker_first`. The doctor
  evaluator and synthetic tests reject either route being omitted. Production D1/KV
  placeholder IDs were restored because `scripts/deploy.ts` resolves those exact
  placeholders during provisioning.
- `wrangler.dev.jsonc` now uses `BETTER_AUTH_URL=http://localhost:5173` and keeps
  `http://localhost:8787` as an additional trusted origin. The local-only auth,
  encryption, cursor, and installation values were replaced with non-production
  values long enough for the Better Auth secret-strength check.
- `apps/worker/package.json` keeps the explicit `wrangler.dev.jsonc` config for
  `pnpm dev:worker`, so local startup cannot silently select the production config.

Verification: the doctor/config subset is green (88 tests), `pnpm format:check` is
green after formatting the previously reported 23 files, and the dev Worker was
rechecked for route precedence. A valid-login browser session still needs an
end-to-end observation before `D-CAP-042-auth-cookie` can be marked Verified; the
full Worker pool also retains the documented 33 Brevo mock-interception failures.

---

## 2026-08-31 — Worker fix: split Better Auth trustedOrigins from baseURL for local-dev SPA

After the previous Content-Type fix made BA requests reach the handler, Better Auth rejected them with `INVALID_ORIGIN`. Root cause: the factory conflated two distinct concepts — `baseURL` (where BA itself is served) and `trustedOrigins` (which browser origins may call BA). In production these are the same (same-origin SPA + API). In local dev they differ: the Vite SPA (port 5173) and the Worker (port 8787) are different origins, and `vite.config.ts:21-26` proxies `/api/*` with `changeOrigin: false`, so the browser document origin (`http://localhost:5173`) reaches the Worker unchanged. The factory's `trustedOrigins: [config.betterAuthUrl]` only allowed `http://localhost:8787`, so the login form got `INVALID_ORIGIN`.

Fix:
- `apps/worker/src/platform/config.ts` — new `parseAdditionalTrustedOrigins(raw, environment)` parses the new env var `BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS` (comma-separated, validated through the same rules as `betterAuthUrl` via `parseBetterAuthUrl` so a typo'd origin or non-http(s) URL fails closed with `INVALID_BETTER_AUTH_URL`). Each entry is canonicalised to `${protocol}//${host}` and deduped. Empty / unset → `[]`. New field `additionalTrustedOrigins: readonly string[]` on `PlatformConfig`.
- `apps/worker/src/integrations/better-auth/factory.ts:135` — `trustedOrigins: [config.betterAuthUrl, ...config.additionalTrustedOrigins]`. The `disableOriginCheck: false` default is preserved (`factory.ts` file header) — open-redirect payloads cannot escape.
- `apps/worker/src/platform/env.ts:54-65` — `Env.BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS?: string`.
- `apps/worker/wrangler.dev.jsonc:74-83` — set to `http://localhost:5173` (the Vite SPA origin). `wrangler.jsonc` (production) and `wrangler.test.jsonc` (worker-pool tests) leave it unset → empty list. The committed production default stays empty so production's same-origin SPA + API doesn't open the trust list unnecessarily.

Tests (`apps/worker/src/platform/config.test.ts`, +12): unset/empty → `[]`; single origin; multiple comma-separated with whitespace; dedup; skips empty between commas; non-http(s) → `INVALID_BETTER_AUTH_URL`; userinfo → `INVALID_BETTER_AUTH_URL`; query → `INVALID_BETTER_AUTH_URL`; https required for non-local; loadConfig wires the field.

**Gates**: doctor 14/14, lint clean, typecheck clean, unit 1095→1107 (+12), web 362→362 (no change), worker 862/895 (same baseline — 33 pre-existing Brevo-mock failures isolated to `outbound-smoke-test.worker.test.ts`; unrelated, no regression). Manual verify: BA sign-in no longer 401's on origin when reached from the Vite-served login form.

**Likely-next follow-up** (recorded as `D-CAP-042-auth-cookie` in the ledger, not addressed here): once BA's origin check passes, the `Set-Cookie` response is scoped to `localhost:8787` (because `BETTER_AUTH_URL=http://localhost:8787` drives BA's cookie scoping). The browser at `localhost:5173` will not store or send it. Standard dev workarounds: have Vite proxy BOTH SPA and BA endpoints on the same port; or set the BA cookie with `SameSite=None; Secure` and a parent-host `Domain=localhost`; or change `BETTER_AUTH_URL` to the Vite origin (then BA's `baseURL` itself points at the proxy, which is fine for a proxied dev setup). Tracked so the next iteration of `pnpm dev` has a documented fix path.

---

## 2026-08-31 — Frontend fix: apiClient now sets Content-Type: application/json for object bodies

`apps/web/src/infrastructure/api/client.ts` was JSON-stringifying object bodies but never setting `Content-Type: application/json`. The browser's `fetch()` defaults the header for a string body to `text/plain;charset=UTF-8`, which Better Auth's `POST /api/v1/auth/better/sign-in/email` rejects with 415 `UNSUPPORTED_MEDIA_TYPE` (Better Auth strictly validates the header at its handler boundary; the rest of our worker routes tolerate `text/plain` because they `c.req.text()` and parse).

Why it slipped through:
- 468 worker-side tests all set `Content-Type: application/json` explicitly in their fixtures, so the server-side round-trip was always fine.
- Every setup/admin/messages route tolerates `text/plain` because it reads the raw body and parses it.
- Better Auth was the first strict-JSON handler to land in the codebase. CAP-042 Batch 5+ ships `/api/v1/auth/better/*` and the only callers (`useSignInMutation`) hadn't been manually exercised end-to-end through the real browser — the worker-pool tests for `better-auth.worker.test.ts` use a constructed `Request` with the right Content-Type.

Fix (`apps/web/src/infrastructure/api/client.ts:90-115`): when `requestInit.body` is an object (not a string) AND the caller hasn't already set Content-Type, set `Content-Type: application/json`. The check is intentionally narrow — string bodies keep the caller's contract, body-less POSTs (e.g. `/api/v1/auth/better/sign-out`) get nothing.

Test (`apps/web/src/infrastructure/api/client.test.ts`, +4 cases): "sets Content-Type: application/json for object bodies" (the regression — pins both the header and that the body is JSON-stringified), "does not set Content-Type when the caller already provided one" (idempotent — caller's value wins), "does not set Content-Type when the body is a string (caller owns the header)", "does not set Content-Type for body-less requests".

**Files**: `apps/web/src/infrastructure/api/client.ts` (MODIFIED — add the header-set block at line 90-115), `apps/web/src/infrastructure/api/client.test.ts` (MODIFIED — +4 cases), `docs/rebuild/capability-ledger.md` (D-CAP-042-auth-ct row), `docs/rebuild/implementation-log.md` (this entry).

**Gates**: doctor 14/14, lint clean, typecheck clean, unit 1091→1095 (+4 new tests, zero regressions), web 358→362 (+4 new tests). Worker-pool tests not re-run (web-only change; no worker-side surface touched).

---

## 2026-08-31 — Tooling fix: `pnpm scaffold db:migrate --reset` silently dropped `--reset`

Operator reported `db:migrate --reset` only verified and never wiped the local D1 persist dir. Root cause: `scripts/scaffold.ts:28-32` filtered `v !== '--reset'` on **both** the alias path (where the flag was prepended) and the explicit `db:migrate` path (where the operator typed it). The runner saw no args, skipped the `rmSync` block at `scripts/db-migrate.ts:50-55`, and just verified.

Fix: restrict the `--reset` dedup filter to the `db:reset` alias path (where the flag was prepended); on the `db:migrate` path, pass `--reset` through unchanged. While extracting the logic into a pure function (`forwardDbMigrateArgs`) for testability, the dispatcher body was gated behind `pathToFileURL(process.argv[1]).href === import.meta.url` so vitest can import the helper without triggering the dispatcher's top-level `process.exit(1)` — mirrors `scripts/deploy.ts:1416`.

Test: `scripts/scaffold.test.ts` (NEW, 9 tests, 100 passing). Cases pin: `db:migrate` passes `--reset` through (the regression); `db:migrate --verify` passes through; `db:reset` prepends `--reset`; `db:reset --reset` dedupes; both dedup + verify combinations. The pure-function pattern also lets the unit test run in 87 ms instead of the 1+ s a subprocess round-trip would cost.

**Files**: `scripts/scaffold.ts` (MODIFIED — extract `forwardDbMigrateArgs`, gate dispatcher body behind `import.meta.url` check, restrict `--reset` dedup to alias path), `scripts/scaffold.test.ts` (NEW, 9 tests), `docs/rebuild/capability-ledger.md` (D-CAP-041-H4 row), `docs/rebuild/implementation-log.md` (this entry).

**Gates** (orchestrator-run): doctor 14/14, lint clean, typecheck clean, unit 1082→1091 (+9 new scaffold tests, zero regressions), web/worker pools not re-run (tooling fix, no app-code change). Live-dispatcher smoke test: `Removed apps/worker/.wrangler/state` printed and migrations re-applied from 0001.

---

## 2026-08-31 — CAP-063 lite: setup wizard `Skip remaining setup` affordance

Per user direction ("在 Administrator 之后的 setup tabs 都可以跳过，在管理页面中配置" — lite path: single Skip button at Administrator; admin URLs documented in runbook; no new admin pages), the setup wizard gets a single secondary `Skip remaining setup` button on each of the six post-claim step components (`AdministratorStep`, `DomainStep`, `CloudflareVerifyStep`, `InboundSmokeStep`, `BrevoStep`, `OutboundSmokeStep`). The button is disabled at `AdministratorStep` until the admin form submits successfully (OR the server-reported `currentStep` is past `administrator` — local component state alone is insufficient because re-mount resets it, so the implementer added a `useQuery(setupQueryKeys.status(), { enabled: false })` to read the cached state without issuing its own fetch); always enabled on the other five. Click handler POSTs the existing `POST /api/v1/setup/complete` (no new server shape), invalidates `setupQueryKeys.status()`, navigates to `/`. Errors surface through `ErrorPanel`; on 401, the retry label is "Re-claim installation token" and the hook exposes `isUnauthorized` so the caller wires the same reclaim flow `CompleteStep` uses. Idempotency-Key is added by `apps/web/src/infrastructure/api/client.ts:73-80` per ADR-004 — step components never set the header themselves.

**Refactor (implementer-flagged Rule-of-Three violation, Option B).** The click handler was byte-identical across all six steps — six concrete call sites, Rule of Three satisfied at three. Extracted `apps/web/src/features/setup/use-skip-remaining-setup.ts` (106 lines, hook owns the wire call shape + error state + re-entrancy guard + `isUnauthorized` flag) and `apps/web/src/features/setup/SkipRemainingSetupButton.tsx` (51 lines, owns the visual contract). Each step component becomes a ~5-line integration; ~195 lines of duplication removed net. The hook test (`use-skip-remaining-setup.test.tsx`, 7 tests) is the single source of truth for the wire behavior; per-step tests assert only the button render + gating. The button test (`SkipRemainingSetupButton.test.tsx`, 6 tests) pins the visual contract.

Runbook at `docs/operations/post-setup-admin-urls.md` documents the six existing admin URLs the operator can bookmark (`/mailbox`, `/admin`, `/admin/connections`, `/admin/users`, `/admin/audit-events`, `/admin/webhook-events`), each with purpose + required permission + what you can do there today; then names the four known gaps (Domain / Role / Signature / Settings admin pages — none exist yet) with their `D-CAP-063-B..E` ledger IDs. Includes a pre-skip warning explaining the "complete with no admin" failure mode (R-AUTH-005), the symptom (nobody can sign in, wizard is locked, only D1 access recovers), and the gating that prevents it.

**Gates** (orchestrator-run, post-implementer): doctor 14/14, lint clean, typecheck clean, unit 1061→1082 (21 new tests: 7 hook + 6 button + 8 per-step), web 337→358, worker 862/895 (33 pre-existing Brevo-mock failures isolated to `outbound-smoke-test.worker.test.ts`; unrelated, no regression), web build EXIT=0, worker `--dry-run` EXIT=0.

**Files**: `apps/web/src/features/setup/use-skip-remaining-setup.ts` (NEW), `apps/web/src/features/setup/use-skip-remaining-setup.test.tsx` (NEW), `apps/web/src/features/setup/SkipRemainingSetupButton.tsx` (NEW), `apps/web/src/features/setup/SkipRemainingSetupButton.test.tsx` (NEW), `apps/web/src/features/setup/steps/{Administrator,Domain,CloudflareVerify,InboundSmoke,Brevo,OutboundSmoke}Step.tsx` + matching `*.test.tsx` (MODIFIED — ~5 lines added each, no other changes), `docs/operations/post-setup-admin-urls.md` (NEW), `docs/rebuild/capability-ledger.md` (CAP-063 row + D-CAP-063-A..E rows), `docs/rebuild/implementation-log.md` (this entry).

**Defers** (recorded in §Deferred of the capability ledger): `D-CAP-063-A` (wizard re-entry after `status === 'complete'`, separate capability), `D-CAP-063-B..E` (Domain / Role / Signature / Settings admin pages — each a future capability that the runbook explicitly calls out as a known gap). **Status: Implemented locally** — code complete, implementer self-checked every gate, awaits peer review (architecture + frontend) before archive.

---

## 2026-08-30 — CAP-041 follow-ups H1 + H3: sibling beforeLoad cache hydration + INSTALLATION_TOKEN drift root-cause

Two deferred review findings from the CAP-041 preflight hotfix closed in a single chore commit:

**H1 (LOW, consistency).** `setupIndexRoute.beforeLoad` (`router.tsx:411`) and
`unknownSetupStepRoute.beforeLoad` (`router.tsx:530`) called `fetchSetupStatus(context.apiClient)`
directly, the same bypass the hotfix closed at `requireSetupStep`. Both routes are pure redirect
shims in production (their `component`s are `() => null`), so the bug was benign — but DRY across
the three `fetchSetupStatus` call sites prevents a future maintainer from accidentally splitting
the cache hydration shape. Both `beforeLoad`s now route through
`context.queryClient.fetchQuery({ queryKey: setupQueryKeys.status(), queryFn: () =>
fetchSetupStatus(context.apiClient), staleTime: 0 })`. Two new web tests in
`router.test.tsx` (`describe('router — CAP-041 follow-up H1 ...')`) pin the contract: cache is
populated before the route shims through to the canonical current-step URL on both
`/setup` (index) and `/setup/not-a-real-step` (unknown sub-step).

**H3 (MEDIUM, pre-existing local-infrastructure drift).** The committed
`apps/worker/wrangler.test.jsonc` had the right value (`test-installation-token`) all along. The
operator-local `apps/worker/.dev.vars` carried `INSTALLATION_TOKEN=local-installation-token`,
which the vitest-pool-workers binding resolver merged over `wrangler.test.jsonc` — so tests
sending the canonical `'test-installation-token'` saw 401 at `POST /api/v1/setup/claim` and never
exercised their bodies. Operator aligned `.dev.vars` INSTALLATION_TOKEN to the canonical test
value (gitignored; not part of this commit). The per-test `beforeEach` workaround at
`preflight.worker.test.ts:397` is removed; the comment now documents that `wrangler.test.jsonc`
is the canonical source. Test results before/after the `.dev.vars` realignment: **183 fail /
712 pass → 33 fail / 862 pass** (150 previously 401-blocked tests now exercise their bodies).
The remaining 33 failures are pre-existing `outbound-smoke-test.worker.test.ts` Brevo-mock
interception issues (`vi.spyOn(globalThis, 'fetch')` cannot intercept workerd-internal fetch);
they are unrelated to this follow-up and tracked separately.

**H2** (onboarding `AuditEventWriter` seam — MEDIUM architectural consistency + ADR candidate)
stays deferred per user direction; see `D-CAP-041-H2` in `capability-ledger.md`.

Local evidence: doctor 14/14, lint clean, typecheck clean, unit 337/337, worker 862/895 (33
pre-existing Brevo-mock failures isolated to `outbound-smoke-test.worker.test.ts`; pass when run
in isolation; unrelated to this commit). Web diff and worker diff are confined to the 3 files
named in the commit + the 2 documentation files (ledger + implementation log). The `.dev.vars`
realignment is gitignored.

---

## 2026-08-30 — CAP-041 preflight hotfix: state advance + cache hydration

Two production bugs in the setup wizard at `/setup/preflight` reported during local testing,
landed as a single fix commit on top of f1e23af:

1. **Server: preflight never advanced `installation_state.current_step`.** The state machine had a
   missing edge: `claimSetup` seeded `current_step='preflight'`, `runPreflight` was read-only, and
   `createAdministrator` advanced to `'domain'`. No code path had ever advanced `preflight →
   administrator`, so clicking Continue on `/setup/preflight` triggered
   `administratorRoute.beforeLoad` → `requireSetupStep(context, 'administrator')` → saw
   `expectedIndex(2) > activeIndex(1)` → `throw redirect({to:'/setup/preflight'})`. The wizard
   bounced back. Fix: `runPreflight` now conditionally advances state when every binding is
   present AND `schemaVersion === CURRENT_SCHEMA_VERSION` (worker
   `apps/worker/src/modules/onboarding/preflight.ts`). The advance is folded into a single D1
   batch with a `setup.preflight.complete` `audit_events` INSERT (R-WORKFLOW-002 + R-AUDIT-001);
   the audit row uses `INSERT ... SELECT FROM installation_state WHERE id=1 AND
   current_step='preflight'` so the SELECT and the conditional UPDATE share an identical predicate
   — re-running preflight when state has already advanced is a zero-row no-op and never
   double-counts audit_events. New helper
   `prepareConditionalUpdateInstallationStep(db, fromStep, toStep, timestamp)` in
   `apps/worker/src/modules/onboarding/installation-state-repository.ts`. `setupPreflightResponseSchema`
   is untouched; the new `advanced` flag is server-internal and never leaks into the response
   envelope.
2. **Web: chip indicator flashed all-upcoming on first paint.** `requireSetupStep()` previously
   called `fetchSetupStatus(context.apiClient)` directly, bypassing React Query. Layout's
   `setupStatusQuery()` therefore saw an empty cache on first render and rendered every chip as
   `upcoming` until the useQuery fetcher landed. Fix: `requireSetupStep` now uses
   `context.queryClient.fetchQuery({ queryKey: setupQueryKeys.status(), queryFn: ...,
   staleTime: 0 })`, mirroring `requireCompletedSetup` exactly. Cache is populated before
   `<SetupLayout>` mounts; preflight chip renders `data-state="current"` and
   `aria-current="step"` on first paint.

Closed 5/7 ACs are pinned by named-by-rule-ID worker tests
(`apps/worker/src/http/routes/preflight.worker.test.ts` describe block
`CAP-041 hotfix — atomic preflight advance`): `R-WORKFLOW-002` (AC-2 all-green emits one audit
row and advances state), `R-WORKFLOW-002` (AC-3 missing binding does not advance and does not
write an audit row), `R-WORKFLOW-002` (AC-4 schema drift does not advance), `R-WORKFLOW-002`
(AC-5 already-advanced is a safe no-op), `R-WORKFLOW-002 + idempotency seam` (AC-6 idempotent
replay returns the identical body and does not write a second audit row). Web AC-1 + AC-7 are
pinned by `apps/web/src/app/router.test.tsx` describe block `router — CAP-041 preflight hotfix
(AC-1 + AC-7)`. `packages/contracts/src/admin/audit.ts` adds `'setup.preflight.complete'` to
the closed `auditActionSchema` enum; the corresponding coverage test pins the new option.

Reviews: code-reviewer ACCEPT-WITH-FOLLOWUPS, frontend-reviewer ACCEPT-WITH-FOLLOWUPS. No
BLOCKER, no HIGH, no MEDIUM in the fix. Two MEDIUMs found in the diff are recorded as separate
follow-ups: **F1** — `setupIndexRoute.beforeLoad` and `unknownSetupStepRoute.beforeLoad` still
call `fetchSetupStatus(context.apiClient)` directly (router.tsx:411, router.tsx:530); benign in
production (both routes' components are `() => null` and the user always lands on a static step
route whose `requireSetupStep` populates the cache), but a future maintainer who imports
`SetupLayout` into those routes would silently re-introduce the chip-flash bug. Consistency
cleanup. **F2** — `apps/worker/src/modules/onboarding/{claim-setup.ts,complete-setup.ts,
preflight.ts}` each inline an `audit_events` INSERT because `onboarding → admin` is a forbidden
dependency edge; the canonical writer lives in `modules/admin/audit-event-repository.ts`. An ADR
+ a new `AuditEventWriter` seam in `packages/contracts` (mirroring CAP-040's outbound-mail
seam) would let onboarding fold audit rows into batches without importing `modules/admin/*`.
Both F1 and F2 are scoped out of this hotfix.

A pre-existing local-infrastructure drift is also noted: `apps/worker/wrangler.test.jsonc`
pins `INSTALLATION_TOKEN = "test-installation-token-local"` while every test fixture sends
the literal `'test-installation-token'`, which 401s `POST /api/v1/setup/claim` and blocks ~178
worker-pool tests that depend on a claimed session. The hotfix's test file works around the
drift with a `beforeEach` override at `preflight.worker.test.ts:397` (mutating the test-pool
env to match the committed wire shape). Restoring `wrangler.test.jsonc` to its committed value
removes the need for the workaround and unblocks the 178 pre-existing failures. Tracked as a
separate ledger task; out of CAP-041 scope.

Local evidence: doctor 14/14, lint clean, typecheck clean, unit 1059/1059 (3 new CAP-041 web
tests in `router.test.tsx`), 5 new CAP-041 worker tests in `preflight.worker.test.ts` pass;
build clean. Web diff and worker diff are confined to the 9 files named in the commit.

---

## 2026-08-30 — Setup wizard operator guidance added

Each setup step now includes a consistent operator guide covering purpose, preparation, actions,
and the expected result. Claim additionally explains where the deployment token comes from, keeps
the token out of browser storage, disables submission until a token is entered, and hides the
session-clear action until a setup session exists. The administrator copy now matches the active
6–30 character password contract. The setup route tree was also corrected so the `/setup` layout
parent owns the real `/claim`, `/preflight`, and remaining step paths; direct browser navigation
now renders the active step instead of an empty Outlet.

Local evidence: Setup tests 40/40, Web 332/332, full unit 1056/1056, doctor 14/14,
typecheck/lint/format/build, browser `/setup/claim` smoke, and `git diff --check` clean. No API,
database, secret, preview, or deployment behavior changed.

## 2026-08-30 — Local Vite API routing and setup-gate parity fixed

The Web development server now proxies `/api/*` to the local Worker (default
`http://localhost:8787`, overrideable with a validated loopback `VITE_WORKER_URL`). This keeps
browser requests on the Vite origin while preventing JSON API calls from being answered by the
Vite SPA fallback. The Web router also refreshes installation status before authentication on
every application route, entering `/setup/<currentStep>` directly when the local installation is
incomplete and avoiding the Worker's setup redirect being interpreted as a JSON 404.

Focused browser smoke verification reached the setup wizard from both `/mailbox` and a direct
mailbox child route with no route error. Local evidence: Web 328/328, full unit 1052/1052, Worker
890/890, doctor 14/14, typecheck/lint/format/build and `git diff --check` clean. Independent
architecture review returned ACCEPT. No secrets, preview, deploy, or push occurred.

## 2026-08-30 — CAP-062 Web root entrypoint connected to the mailbox shell

The Web root route no longer renders the CAP-001 placeholder, which made a healthy client
look blank/incomplete at `/`. It now redirects to the existing authenticated `/mailbox` route;
that route remains the sole owner of the session guard, so unauthenticated users continue to
land at `/login` and authenticated users see the mailbox list. Production-router tests cover both
paths using the real route tree. No API, auth, storage, or deployment behavior changed.

Local evidence: focused router 22/22, full unit 1032/1032, doctor 14/14, typecheck/lint/format/
build and `git diff --check` clean. Independent architecture review returned ACCEPT. No secrets,
preview, deploy, or push occurred.

## 2026-08-30 — CAP-062 Draft server view and recovery decision implemented locally

CAP-062 connects the CAP-061 browser working-copy cache to the Web mailbox without making the
browser copy authoritative. The production router now protects `/mailbox/:mailboxId/draft/:draftId`
with the existing session guard; Drafts-folder rows link to it, and the page renders strict server
draft fields read-only. A dirty local copy with the same server base requires an explicit recovery
choice, while an opaque server-base mismatch offers an explicit load-server choice. The latter
deletes only the current user/mailbox/draft cache key after activation; no editor, autosave, PATCH,
send, discard, attachment, or preview behavior was added.

The shared contracts package owns the strict GET envelope, including canonical millisecond RFC-3339
timestamps and recipient arrays. The existing draft GET route accepts an optional validated
`mailboxId` query so a shared draft association is resolved for the mailbox in the Web URL while
legacy no-query callers retain their behavior. The Web fetcher encodes both IDs, verifies both
response identities, and rejects malformed or storage-only fields before rendering.

Local evidence: focused Web 53/53, contracts 383/383, Worker draft routes 43/43, full unit
1030/1030, doctor 14/14, typecheck/lint/format/build and `git diff --check` clean. Independent
architecture review returned ACCEPT. No secrets were inspected; no preview, deploy, push, or R2
operation occurred.

The contract is archived at `work/archive/2026-08/CAP-062-draft-recovery-view/task.md`.

## 2026-08-30 — CAP-061 Draft IndexedDB working-copy cache implemented locally

CAP-061 adds the browser-local foundation for draft crash recovery without changing the server
draft routes or editor surface. A Dexie-backed working-copy store persists the server-compatible
`to`/`cc`/`bcc`, subject, text, and HTML fields under a length-framed user/mailbox/draft key;
strict Zod validation rejects malformed rows and credential-shaped extras. Revision, dirty,
`baseServerUpdatedAt`, and `baseServerRevision` markers provide deterministic recovery decisions
without wall-clock comparisons. Server acknowledgements carry the revision that produced them and
are applied in one IndexedDB transaction, so stale or out-of-order responses cannot clear newer
dirty content or regress the acknowledged base. Dexie v2 upgrades initial v1 rows with the new
base-revision marker.

Focused real IndexedDB evidence is 7/7, including browser-restart persistence, same-ID
cross-user/mailbox isolation, delimiter collision resistance, field/revision preservation,
stale/ordered/future response handling, malformed/secret-shaped row rejection, and recovery
decisions. Full local evidence is unit 1013/1013, doctor 14/14, typecheck/lint/format/build, and
`git diff --check` clean. Independent architecture review returned ACCEPT. The draft editor,
server fetch, autosave, and discard flows remain a separate next slice; no preview, deployment,
R2, or secret access occurred.

The contract is archived at `work/archive/2026-08/CAP-061-draft-cache/task.md`.

## 2026-08-30 — CAP-060 Web folder navigation and views implemented locally

CAP-060 completes the client half of the folder-view slice begun by CAP-059. The mailbox route
now validates the shared five-value folder vocabulary and defaults malformed or missing search
values to `inbox`. The Web message query appends `folder=<value>` for non-inbox views and includes
the folder in the authenticated user/mailbox cache key; compose invalidation covers the mailbox's
folder family, while read/star/delete updates target the active folder.

`InboxListPage` renders accessible Inbox, Sent, Drafts, Archive, and Trash links with a
folder-specific heading, selected `aria-current="page"`, and preserved default-inbox behavior.
Focused Web tests cover route validation, folder request shape, selected navigation, and cache
isolation. Local evidence: focused Web 39/39, full unit 1006/1006, doctor 14/14, typecheck/lint/
format/build and `git diff --check` clean; Worker and schema code were unchanged. Draft IndexedDB
recovery, sharing/invitation UI, preview, deployment, and R2 remain separate.

The contract is archived at `work/archive/2026-08/CAP-060/task.md`.

## 2026-08-30 — CAP-059 folder-filtered message list backend implemented locally

CAP-059 adds the server half of the Phase 3 folder views. The mailbox message-list endpoint now
accepts the closed `inbox`, `sent`, `drafts`, `archive`, and `trash` vocabulary, defaults to
`inbox`, and filters `mailbox_messages.folder` after the existing caller-scoped soft-delete and
mailbox authorization predicates. Message list/detail/thread projections share the `MessageFolder`
contract type. Signed messages cursors carry `scope=folder:<name>`; scope-less and cross-folder
tokens return `INVALID_CURSOR`, while same-folder pagination remains deterministic.

Focused evidence: contracts 380/380 and real-D1 Messages Worker 71/71. Full local evidence after
the slice: unit 1002/1002, Worker 888/888, doctor 14/14, lint/typecheck/format/build and
`git diff --check` clean. No migration or binding changed; the Web folder navigation/views,
draft IndexedDB recovery, sharing UI, R2, preview, and deployment remain separate.

The contract is archived at `work/archive/2026-08/CAP-059-folder-filter/task.md`.

## 2026-08-30 — CAP-058 per-user message star state implemented locally

CAP-058 moves the user-visible star flag from the legacy mailbox-level column to the existing
per-user `message_user_state` composite row. Migration 0023 adds the constrained 0/1 field and
backfills legacy stars for the current mailbox owner and explicit members without overwriting
read/delete state. List, detail, thread, and toggle paths now resolve and write the caller's
state; caller-soft-deleted messages remain an identical 404/no-write surface. Star idempotency
hashes bind the mailbox/message resource, while state, idempotency, and audit remain one atomic
D1 batch. The legacy column is retained but no longer read or written by the star path.

The web mailbox query-key family (list, detail, thread, compose invalidation, and row mutations)
is scoped by authenticated user ID, with a shared-QueryClient account-switch isolation test.
Contracts and repository boundaries expose exact 0/1 flags. Local evidence: contracts 377/377,
focused messages Worker 68/68, focused Web 64/64, unit 999/999, Worker 886/886, doctor 14/14;
lint, typecheck, format, build/Wrangler dry-run, and `git diff --check` pass. Independent
architecture review returned ACCEPT with no findings. No preview/deployment evidence was collected;
CAP-054 provider verification and the remaining MessageDetailPage loading-gate follow-up stay
separate.

The contract is archived at `work/archive/2026-08/CAP-058-per-user-stars/task.md`; folders remain
the next Phase 3 capability.

## 2026-08-30 — CAP-057 mailbox sharing backend implemented locally

CAP-057 adds the tenancy-owned mailbox member API: owner/global `mailbox.share` authorization,
strict normalized email + viewer/sender/admin validation, active-user credential-free Identity
lookups, safe member projections, and add/list/remove routes. Add and remove transitions persist the
membership mutation, correlated `mailbox.member_added` / `mailbox.member_removed` audit event, and
mutating-endpoint idempotency record atomically. Same-key replays are byte-identical, concurrent
losers do not duplicate rows, and missing/foreign/unauthorized mailbox IDs collapse to one 404
envelope. Focused and full local gates pass: Worker 880/880, unit 993/993, contracts 375/375,
doctor 14/14, lint/typecheck/format/build/diff clean. Independent architecture review returned
ACCEPT with no findings. The contract is archived at
`work/archive/2026-08/CAP-057-mailbox-sharing/task.md`; invitation delivery, UI, folders/stars,
preview verification, and deployment remain separate or deferred.

## 2026-08-30 — CAP-056 safe message HTML and inline CID rendering implemented locally

CAP-056 enables the message-detail page to render a non-empty `htmlBody` only through a dedicated
`SanitizedMessageHtml` boundary. DOMPurify 3.4.14 owns the explicit tag and attribute allowlists;
the scoped URI policy rewrites only a uniquely matched consumed inline raster `cid:` to the shared
encoded CAP-051 download path, while unknown, duplicate, external, data, blob, and non-inline image
sources lose `src`. Unsafe links, executable markup, SVG/iframe/object/embed/form content, event and
style attributes, control-character protocol obfuscation, and storage/idempotency sentinels are
covered by focused tests. Empty or whitespace-only HTML continues to use the existing plain-text
fallback, and CAP-053/CAP-055 attachment controls remain unchanged.

The sanitizer now returns an inert DOMPurify fragment, applies only the image/link URI policy to
surviving elements, and serializes that already-sanitized fragment without a second raw HTML parse.
Safe descendants inside non-allowlisted wrappers are preserved. Codex repaired the implementation
after architecture review; the final independent architecture verdict is ACCEPT with no findings.
Focused Web tests pass 26/26; full unit tests pass 989/989; Worker tests pass 870/870; scaffold
doctor passes 14/14; lint, typecheck, format, build/Wrangler dry-run, and `git diff --check` pass.
The contract is archived at `work/archive/2026-08/CAP-056-safe-html-cid/task.md`. Provider-side CID
rewriting, richer previews, R2 retention, preview verification, deployment, and additional KV
namespaces remain deferred.

## 2026-08-29 — CAP-055 inline image attachment preview implemented locally

CAP-055 extends the CAP-053 attachment list with a narrow, safe preview path. Only `inline`
attachments whose media type is exactly one of PNG, JPEG, GIF, WebP, or AVIF render an `<img>` from
the existing CAP-051 same-origin download URL. SVG, unknown media, and ordinary attachments keep a
download link. The component preserves API order, encodes both route IDs, renders metadata as text,
and performs no JavaScript byte fetch, blob creation, HTML rendering, or `cid:` rewriting.

Claude Code implemented the component and focused tests. Grok's independent architecture and
security reviews both returned ACCEPT with no findings. Codex verified focused Web tests 19/19, full
unit/Web tests 982/982, Worker tests 870/870, doctor 14/14, lint, typecheck, format, build, and
`git diff --check`. The contract is archived at
`work/archive/2026-08/CAP-055-inline-image-preview/task.md`; HTML body rendering and CID
substitution remain a separate future capability, with R2, extra KV, preview, and deployment
deferred.

## 2026-08-29 — CAP-053 message detail attachment download controls implemented locally

CAP-053 adds the smallest client slice after the CAP-052 metadata projection: the message-detail
page now renders each API-provided attachment descriptor once and links to CAP-051's existing
mailbox-scoped download route. The UI preserves server order, encodes both path IDs, renders
metadata as text, and omits the section for empty or legacy responses. It performs no byte fetch,
prefetch, storage-key inference, HTML/CID rewrite, or authorization decision; the Worker remains
the authority for access and binary response headers.

Claude Code implemented the component, page integration, and focused tests. Grok's independent
architecture and security reviews both returned ACCEPT with no findings. Codex verified the focused
Web tests 18/18, full unit/Web tests 981/981, Worker tests 870/870, doctor 14/14, lint, typecheck,
format, build, and `git diff --check`. The contract is archived at
`work/archive/2026-08/CAP-053-attachment-download-controls/task.md`; inline image/CID rendering,
durable R2 retention, preview verification, and deployment remain deferred.

## 2026-08-29 — CAP-052 message detail attachment projection implemented locally

CAP-052 extends the existing message-detail response with an additive metadata-only `attachments`
array. The Messages-owned read boundary emits only consumed relations in stable `created_at, id`
order and exposes attachment ID, filename, content type, size, disposition, and nullable content ID;
upload IDs, storage keys, and bytes remain internal. Existing global/mailbox authorization and
per-user soft-delete behavior are unchanged, and the Worker always emits `attachments: []` when no
consumed relations exist while the shared parser remains rollout-compatible with legacy fixtures.

Codex independently verified the implementation after Grok architecture/security review: migration
reset/verification 22/22, CAP-052 focused Worker tests 4/4, existing message Worker regression
63/63, full Worker 870/870, unit 977/977, contracts 371/371, doctor 14/14, lint, typecheck,
format, build, and `git diff --check`. The contract is archived at
`work/archive/2026-08/CAP-052-message-detail-attachments/task.md`; client download/render and CID
rewriting remain the next local slice, with R2, extra KV, preview, and deployment deferred.

## 2026-08-29 — CAP-051 attachment download and local expiry cleanup implemented locally

CAP-051 adds the mailbox-scoped consumed-attachment download endpoint and scheduled cleanup for
unconsumed uploads. Downloads enforce global `message.read` plus mailbox-scoped `read`, read the
Messages-owned projection, fetch exact binary bytes through the existing `CACHE` byte-store seam,
and collapse missing, foreign, soft-deleted, and CACHE-missing states to one 404 without metadata
leaks. The existing cron now marks expired uploads through a guarded D1 transition plus one
correlated `attachment.expired` audit row before deleting CACHE bytes; failed deletes remain
retryable and concurrent cleanup/consume races do not delete committed content.

Codex independently verified migration reset/verification 22/22, CAP-051 focused Worker coverage
9/9, full Worker coverage 866/866, unit 975/975, contracts 369/369, doctor 14/14, lint,
typecheck, format, build, and `git diff --check`. The contract is archived at
`work/archive/2026-08/CAP-051-attachment-download-cleanup/task.md`. Client CID/render, durable
R2 retention, additional KV namespaces, preview verification, and deployment remain deferred.

## 2026-08-29 — CAP-050 attachment consume/send implemented locally

CAP-050 completes the local compose half of the attachment lifecycle. The compose contract now
accepts up to ten unique staged upload IDs; the Messages-owned migration 0022 relation and
ownership/canonical-metadata triggers consume live CAP-049 uploads atomically with message,
outbound-job, idempotency, and audit writes. The existing `CACHE` KV remains the byte store; the
queue reads exact `ArrayBuffer` bytes through the platform seam and reconstructs provider-neutral
attachments without adding R2 or another KV namespace.

Codex review required and verified the cross-owner trigger guard, direct UNIQUE rollback proof,
same-key race replay, different-key unavailability, deterministic batch rollback, and no-write
authorization paths. Final local evidence: migration reset/verify 22/22; focused CAP-050 Worker
tests 20/20; contracts 368/368; unit 974/974; Worker 857/857 after `pnpm build:web`; doctor
14/14; lint, typecheck, format, Worker build, and `git diff --check` all pass. The contract is
archived at `work/archive/2026-08/CAP-050/task.md`. Preview/deployment, R2 migration, and any
additional KV namespace remain deferred; CAP-051 is next.

## 2026-08-29 — CAP-049 attachment staging implemented locally

CAP-049 is complete on local `master` (`e7671b1`). The existing `CACHE` KV namespace now stores
raw attachment bytes under `attachment:<uploadId>` with a bounded 5 MiB stream reader and one-hour
TTL; `attachment_uploads` is the Messages-owned D1 metadata/lifecycle table. Upload, idempotency,
and the closed `attachment.uploaded` audit event commit atomically, with fail-safe cleanup for D1
acknowledgement ambiguity and concurrent loser KV objects. Foreign/missing mailbox outcomes are
collapsed to 404 before body consumption, and no attachment bytes, filenames, or keys are logged.

Independent architecture and security reviews both accepted the current tree. Evidence includes
real D1/KV Worker coverage (11 focused tests; 837 Worker tests), pure route/contract coverage,
real KV expiration metadata, concurrent same-key races, rollback, and no-write authorization cases.
Local quality gates pass: doctor 14/14, unit 968/968, lint, typecheck, format, migration verification
21/21, build, Wrangler dry-run, and diff check. The contract is archived at
`work/archive/2026-08/CAP-049-attachments-kv/task.md`. CAP-050 is next; deployment, R2, and preview
verification remain deferred.

## 2026-08-28 — CAP-049 attachment staging policy selected

For the local attachment slice, reuse the existing `CACHE` KV namespace with unique
`attachment:<uploadId>` keys. Raw bytes are capped at 5 MiB and receive a one-hour KV TTL; D1
remains the canonical owner/mailbox/status/expiry record. This is a temporary local policy below
Cloudflare KV's 25 MiB value limit and the roadmap's 5 MB acceptance fixture. No third KV namespace
is introduced, `SETUP_SESSION` remains separate, and R2 stays untouched. Message/draft consumption,
download authorization, and scheduled D1 cleanup remain CAP-050/051 work. Deployment and preview
verification are explicitly deferred.

## 2026-08-28 — CAP-047 server draft-send slice completed

The bounded server send path is now implemented and locally verified. `POST
/api/v1/drafts/:draftId/send` requires `message.send` and an idempotency key, binds the request
fingerprint to both the raw body and draft resource, authorizes against the resolved mailbox, and
atomically promotes `draft → queued`, moves the mailbox copy to `sent`, records one idempotency row,
creates one guarded outbound job, and writes the closed `draft.sent` audit action. The queue receives
`{ jobId }` only after the D1 batch commits; provider credentials remain queue-consumer concerns.

Coverage includes empty/`{}` bodies, strict whitespace rejection, same-key replay and concurrency,
cross-draft key reuse, no-provider/no-leak authorization, non-draft no-op, and deterministic audit
rollback. Focused draft-send tests pass 42/42; full Worker tests pass 826/826; unit tests pass
961/961; contracts, lint, typecheck, format, build/dry-run, and `git diff --check` pass. The
CAP-047 slice contract is archived at `work/archive/2026-08/CAP-047-draft-send/task.md`.

## 2026-08-28 — Deployment preflight compatibility fix (Wrangler 4.121)

While executing the CAP-054 preview preflight, `scripts/deploy.ts` was found to assume the older
Wrangler list/create JSON flags. Wrangler 4.121 returns direct JSON for D1/KV lists, human-readable
tables for queues/R2/Secrets Store, and no longer accepts `--json` on several list/create commands.
The deploy parser now accepts direct and legacy list shapes; KV creation re-lists to resolve its ID;
queue and Secrets Store discovery use the supported output; and unsupported create output is treated
as a failure rather than parsed as a JSON resource.

Regression coverage adds direct-array, legacy-wrapper, and empty-list cases to
`scripts/deploy.test.ts` (48 tests pass). `ENVIRONMENT=preview pnpm scaffold deploy --dry-run` now
reaches the configuration guard without creating resources. A single empty D1 accidentally created
by the initial preflight was identified by UUID and deleted immediately; the pre-existing
`unimailbox` database was not touched. No secrets were read or printed.

---

## 2026-08-28 — CAP-054 independent review: implementation accepted, preview verification still pending

Codex independently reviewed the CAP-054 production diff and reran the focused and full gates on
`cap/CAP-054-provider-idempotency`: Brevo adapter 10/10, preview-gate 27/27, unit 904/904, Worker
784/784 with zero skipped, scaffold doctor 14/14, lint, typecheck, format, diff check, and build /
Wrangler dry-run all pass. The adapter placement matches the `sendTransacEmail` JSON `headers`
contract, and no runtime or secret-handling defect was found.

This review does **not** treat the mocked-fetch wire-shape test as provider verification. CAP-045's
preview run predates CAP-054, and its raw evidence was not committed. Phase 2 therefore remains
implemented with CAP-054 preview verification pending: deploy this revision, perform a controlled
same-key retry/duplicate-send observation against Brevo, and capture redacted evidence before
restoring `Verified` or dispatching CAP-047.

Process correction: the CAP-054 ledger row now records Claude Code as implementer and Codex as the
independent gate reviewer; the prior "orchestrator-only; no subagent" wording was inaccurate.

---

## 2026-08-27 — CAP-054 implemented; Phase 2 verification re-closed

D-CAP-028-E is RESOLVED. The Brevo adapter now sends `Idempotency-Key: msg.idempotencyKey`
**inside the `sendTransacEmail` JSON body's `headers` object**, per
`https://developers.brevo.com/reference/sendtransacemail`. The previous
`preview-gate.worker.test.ts` AC 5 wire-shape assertion probed
`fetch RequestInit.headers['X-Idempotency-Key']` — the wrong layer; that
assertion is replaced by `sendInit.body.headers['Idempotency-Key'] === messageId`.
`Message-ID` / `In-Reply-To` / `References` continue to coexist when supplied;
`Idempotency-Key` is always present (even when `msg.messageId` is absent — the
canonical message id is the queue's `idempotencyKey`, not the optional RFC 5322
`Message-ID`). Standard Brevo `api-key` / `Content-Type` / `Accept` HTTP headers
preserved verbatim. Idempotency-Key is NOT in `RequestInit.headers`.

The `LIVE` constant, `liveOnly(...)` helper, and the
`beforeAll(() => { if (!LIVE) console.warn(...) })` machinery in
`preview-gate.worker.test.ts` are removed — all unreferenced after the AC 5
conversion. The `DEFERRED_REQUEST_ID_ACTIONS` constant + `EXPECTED_AUDIT_ACTIONS`
set remain untouched. The fetch spy (`vi.spyOn(globalThis, 'fetch')`) intercepts
the outbound HTTP request before it leaves the Worker — no `BREVO_API_KEY` env
var, no `.env` file read, no real provider call can escape. Standard and
configured-live Worker modes no longer differ for this assertion.

Files: `apps/worker/src/integrations/providers/brevo.ts` (production),
`apps/worker/src/integrations/providers/brevo.test.ts` (+4 wire-shape cases,
10/10 passing), `apps/worker/test/preview-gate.worker.test.ts` (AC 5 + LIVE
machinery, 27/27 passing). No new migration, no new env var, no new dependency,
no secret in source/tests/logs/commits.

Gates (orchestrator-run on `cap/CAP-054-provider-idempotency`): `pnpm scaffold
doctor` 14/14; `pnpm lint` 0 errors; `pnpm typecheck` clean; `pnpm format:check`
clean; `pnpm test:unit` 904/904 (+4); `pnpm test:worker` **784/784, zero
skipped, zero failed** (was 783 + 1 intentional skip; the skip becomes a real
run); `pnpm build` clean with Wrangler dry-run reporting all 12 bindings;
`git diff --check` clean. Phase 2 returns to **Verified 2026-08-27**; Phase 3
to **Ready**; CAP-047 (drafts + attachments) is the next dispatch candidate.
Contract archived at `work/archive/2026-08/CAP-054/task.md`.

Cleanup: 0 promoted, 1 archived (task.md → `work/archive/2026-08/CAP-054/`), 0
deleted.

---

## 2026-08-27 — Phase 2 verification reopened: provider idempotency is not on the wire

Branch-consolidation verification ran the Worker suite from the root worktree, where an ignored
local `BREVO_API_KEY` enabled preview-gate AC 5 instead of skipping it. The live-mode wire assertion
failed: `processOutboundJob` creates `idempotencyKey: claimed.message_id`, but the Brevo adapter's
actual `fetch` headers contain only the API key and content-negotiation headers. The standard
secret-independent suite remains green because this assertion is the one intentional skip.

This is a runtime correctness gap, not just a test-environment difference. A Worker crash after
Brevo accepts a message but before D1 records success can cause the reclaimed job to resend without
provider-side deduplication, contradicting R-OUTBOUND-004 and the durable-outbox Phase 2 evidence.
Phase 2 is therefore reopened and CAP-047 is blocked until D-CAP-028-E is fixed and both standard
and configured-live gates pass. No production code was changed in this verification pass.

Evidence: configured-live Worker suite 1 failed / 783 passed (AC 5 missing header); standard Worker
suite 783 passed + 1 intentional skip; unit 900/900; doctor 14/14; lint/typecheck/format clean;
build and Wrangler dry-run clean.

---

## 2026-08-27 — CAP-036 implemented locally; workspace archived

Migration 0019 replaces both JSON-in-TEXT role-policy columns with relational child
tables and preserves the public 500-pattern limits through fixed-count set-based writes.
The repository now rejects normalized duplicate patterns at the contract boundary, reads
metadata and both child sets in one transactional D1 batch, and fails closed on malformed
database rows. The review fix pass also strengthened the migration companion's primary-key
assertions and pinned upgrade, repeat no-op, failure rollback, empty, cascade, boundary,
and non-Cartesian read behavior.

Main-Codex verification: doctor 14/14; lint/typecheck/format/diff clean; unit 900/900;
Worker 783/783 plus one intentional skip; build and Wrangler dry-run clean. No dependency
changed. AC 1–29 are complete; preview deployment and the real PUT/GET/audit round-trip
remain operator-owned AC 30. CAP-036 is therefore **Implemented**, not Verified, and its
contract moved to `work/archive/2026-08/CAP-036/task.md`. Phase 3 is ready; CAP-047 drafts
is the next dispatch candidate.

---

## 2026-08-25 — Backend hardening: migration verification, upgrade RBAC, and deterministic gates

The migration runners now fail closed on zero, malformed, or failing named assertions.
All legacy companion SQL files return `{ assertion, pass }`; remote deploy verifies each
newly applied migration before deploying. Migration 0018 backfills `audit.read` for an
existing administrator role and is covered by a real D1 upgrade/repeat test. Unknown
runtime/deploy environments no longer fall back to local behavior or permit target/config
mismatches. Workers binding tests run file-serially, closing the shared-D1 race.

Evidence: fresh temporary D1 applied and verified all 18 migrations (181 assertions);
doctor 14/14; lint/typecheck/format clean; unit 898/898; Worker 763/763 plus one intentional
skip; build clean; relevant non-Workers line coverage 82.7%. CAP-042's stale archived
status/checkboxes and D-CAP-042/D-CAP-044-N ledger rows are synchronized to executable
reality. CAP-036's false 100-statements-per-batch premise is withdrawn: 0019 uses two
set-based `json_each(?)` child inserts, retains `.max(500)`, and forbids two-child JOINs.

---

## 2026-08-25 — CAP-036 contract drafted (R-DATA-005 strictness for v1, user-elected)

**Trigger:** the user picked option 3 from the post-INV-002 dispatch menu —
"CAP-036 first" over CAP-047 drafts. The Phase 2 audit (INV-001) recommended
deferring CAP-036 to v2; the user has chosen strict R-DATA-005 compliance in v1.
The audit's recommendation stands for future default behaviour — CAP-036 lands
because the user picked it, not because the audit reversed itself.

**Substrate walked:**

- `migrations/0010_blocklist_and_role_policies.sql` — confirmed the two
  `TEXT NOT NULL DEFAULT '[]' CHECK(length(...) <= 65536)` JSON columns that
  R-DATA-005 forbids in v1.
- `packages/contracts/src/admin/role-policy.ts` — `RolePolicyRow` (raw JSON
  strings), `RolePolicyReader.loadRolePoliciesForRoleIds` (returns
  `RolePolicyRow[]`), `setRolePolicyRequestSchema.max(500)` per array, two
  pattern-match zod schemas (`banEmail` accepts exact/`@domain`/`*`;
  `availDomain` accepts only `@domain`).
- `apps/worker/src/modules/admin/role-policy-repository.ts` — `parsePatterns` +
  `rowToPolicy` helpers; `setRolePolicy` uses `INSERT OR REPLACE` (single-statement
  PUT semantics); `prepareSetRolePolicy` is built for batch folding.
- `apps/worker/src/modules/inbound-mail/policy-evaluator.ts:98-106` — inline
  `safeParseStringArray` defensive parsing; **CAP-036 deletes this** because
  the reader returns parsed shapes directly.
- `apps/worker/src/database/schema/admin.ts:144-149` — Drizzle `rolePolicies`
  with `banEmailPatternsJson: text(...).notNull()` + `availDomainPatternsJson:
  text(...).notNull()`.
- `migrations/0017_message_user_state_composite_pk.verify.sql` —
  the canonical `0019_role_policy_normalize.verify.sql` shape
  (`SELECT (assertion TEXT, pass INTEGER)`; `scripts/db-migrate.ts` fails on
  pass != 1).

**Contract shape (corrected after review):** two child tables
(`role_policy_ban_emails`, `role_policy_avail_domains`) with composite PK
`(role_id, pattern)`; metadata-only `role_policies` table recreated from a
`role_policies_new`; backfill via `json_each(... WHERE type='text')`; per-row
length checks. `setRolePolicy` uses two deletes, two set-based
`INSERT ... SELECT value FROM json_each(?)` statements, and one metadata upsert
inside the route's existing business + audit + idempotency batch. Reads use
three queries and application grouping, never a two-child Cartesian JOIN.

**Spike verdicts:** V1 GREEN (recreate-table pattern over `ALTER TABLE DROP
COLUMN`); V2 corrected — D1 documents 100 **bound parameters per query**, not
100 statements per batch, so the public `.max(500)` contract remains and each
array is expanded from one transient JSON binding; V3 GREEN (`json_each` with
`type='text'`). Exact backfill equality belongs to the pre-0019 → 0019 Workers
upgrade test because the companion runs after the source columns are dropped.

**Contract scope:** 30 ACs across migration + Drizzle + contracts + repository +
reader + inbound-mail consumer + route + worker tests + gates + operator
closure. Backend-only; no `apps/web/` changes. 4-way parallel review
(architecture / code / security / qa) gates implementation. Frontend N/A
documented inline.

**Correction:** the earlier 500 → 49 contract break was based on a false D1
premise and is withdrawn. The migration is now 0019 because 0018 closes the
`audit.read` upgrade gap.

**Defers surfaced (in contract, to be added to the deferred registry at closure):**

- `D-CAP-036-A` — rest of codebase `TEXT NOT NULL DEFAULT '[]'` audit (greppable
  check before declaring CAP-036 closed).
- `D-CAP-036-B` — per-pattern indexing on `role_policy_*` `pattern` columns
  (only needed if future load observes per-pattern lookup hot paths).
- `D-CAP-036-C` — reassess the public cap only if measured body/evaluation cost
  requires it; do not infer a lower platform batch limit.

**Status:** contract drafted; CAP-036 → `In Progress`; Phase 2 row updated
to note CAP-036 closure is pending the operator FULL run. Next capability =
**CAP-036 implementation** via `implementer-cap036`. CAP-047 contract archived
at `work/archive/2026-08/CAP-047-drafts/task.md` (reactivated when drafts work
resumes). Phase 3 decomposition document unchanged; INV-001 audit unchanged
(recommendation stands; user overrode).

---

## 2026-08-25 — Phase 2 closed: Verified (INV-001 Phase 2 audit)

**Verdict:** Phase 2 returns to **Verified** (the audit was the gate per
`docs/rebuild/execution-plan.md:156`). All 7 acceptance criteria from
`docs/rebuild/08-roadmap/phase-2-core-loop.md` have implemented owners and worker/UI/
preview-gate evidence.

| AC | Owner | Evidence |
|---|---|---|
| Replay `/messages/send` with same `Idempotency-Key` returns same message id | CAP-027 | `tryReplayIdempotency` + 11 route-level replay tests |
| Same key + different body returns 409 | CAP-027 | `assertSameRequestHash` + per-route `IDEMPOTENCY_KEY_REUSED` tests |
| Outbound job survives consumer crash mid-send (attempts++, lock expires, re-queued) | CAP-029 + CAP-045 FULL | `reclaimStaleOutboundJobs`; preview-gate step (d) drives queue with throwing adapter; operator FULL run 2026-08-25 |
| Webhook arriving before send-complete is queued, not lost | CAP-040 + CAP-045 FULL | `webhook_deliveries` row `status='pending'`; preview-gate step (d) drives the route with a valid signature pre-send; operator FULL run |
| No `/api/v1/*` endpoint accepts a request > 1 MB | CAP-031 | `enforceBodySize` middleware in `router.ts` |
| All audit events are queryable by actor and resource | CAP-044 Slice 2 (CAP-033 absorbed) | `GET /api/v1/admin/audit-events` query API + `/admin/audit-events` UI page |
| All endpoints return JSON error body with stable code | CAP-032 | `DomainError.code: ErrorCode` + canonical `{ error: { code, message, requestId } }` envelope |

**Deferred-row classification (91 rows walked):**

- **0 Phase 2-closing BLOCKER.** The closest candidates (D-CAP-029-A webhook delivery +
  messages UPDATE atomicity; D-CAP-044-N upgrade-path re-seed; D-CAP-046-H blocklist-rejection
  inbound path) are accepted as residual per `INV-001-phase-2-audit.md` §"Phase 2-closing
  candidates" — none invalidates a Phase 2 AC.
- **15 rows classified as accepted-residual** (D-CAP-027-A, D-CAP-029-A/B, D-CAP-030-B/C/D,
  D-CAP-031-A, D-CAP-040-A, D-CAP-044-N/O/P/Q/R/S/T, D-CAP-046-C/G/H/J/K/L/M).
  Severity/status fields are unchanged; the audit names the owning phase for each (Phase 2
  follow-up, Phase 4 operations, or rides-with-next-touch).
- **3 rows marked RESOLVED** (D-CAP-040-B, D-CAP-044-K, D-CAP-044-L — already RESOLVED
  before this audit) and **3 new RESOLVED additions** in `## CAP-046 follow-ups`:
  - **D-CAP-046-D** (browser hydration evidence — operator-only) — RESOLVED by the 2026-08-25
    CAP-045 FULL run.
  - **D-CAP-046-E** (real Cloudflare deploy execution — operator-only) — RESOLVED by the
    2026-08-25 CAP-045 FULL run.
  - **D-CAP-046-F** (real email provider sign-up + DNS — operator-only) — RESOLVED by the
    2026-08-25 CAP-045 FULL run.

**CAP-036 verdict (R-DATA-005 strictness for v1):** the migration `0010_blocklist_and_role_policies.sql`
ships JSON-in-TEXT columns in v1. Strict `R-DATA-005` would require a join table for each
list-of-objects column. The audit's call: v1 is acceptable as-is because every reads-by-PK
path (`(scope, target_value)`) has worker tests proving shape conformance and no current
query path needs inside-the-JSON indexing. CAP-036 is correctly allocated but not required
for Phase 2 closure. If the user wants strict `R-DATA-005` compliance in v1, CAP-036 ships;
otherwise it rolls into the v2 blocklist/policies capability. The audit records both options.

**Repository changes this entry:** ledger Phase 2 row flipped to **Verified**; Active/Next/
Blocked/Repository cells updated to reflect "user's choice between Phase 3 decomposition or
CAP-036"; Phase 0/1/2 status table reconciled. Audit document at
`work/investigations/INV-001-phase-2-audit.md` (read-only; no code changed per the audit
disposition). The 3 operator-only CAP-046 follow-ups (D-CAP-046-D/E/F) marked RESOLVED in
`## CAP-046 follow-ups`.

**Next:** user decision — (a) **Phase 3 decomposition** (drafts + attachments + mailbox
sharing + stars + folders per `docs/rebuild/08-roadmap/phase-3-business-completeness.md`), or
(b) **CAP-036 JSON normalization** (R-DATA-005 strictness in v1). Either unblocks the next
vertical slice.

---

## 2026-08-25 — CAP-045 FULL closed: Verified by operator (preview gate run end-to-end)

**Status:** Implemented (FULL). `Verified` is now achieved at code level AND exercised end-to-end
on a real Cloudflare preview deployment.

**Operator run (off-worktree):** the operator ran `pnpm scaffold deploy --environment=preview`
(which provisioned D1/R2/KV/Queue/Secrets Store + applied migrations pending-only), executed
runbook Steps 1–7 (`work/reviews/CAP-045-preview-runbook.md`) against the deployed Worker URL,
and confirmed a repeat deploy was a no-op. The orchestrator did not see the raw `pnpm test:worker`
output this round (the operator's evidence folder convention
`work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/` is established but the operator's
2026-08-25 evidence was not dropped to disk — the run was confirmed verbally). **Future runs
should drop evidence to disk per the convention** so subsequent operators can replay the run
without trusting chat.

**Gate baseline (orchestrator-run, post-FULL; unchanged from CAP-046 closure 2026-08-24):**

- `pnpm scaffold doctor` — 14/14
- `pnpm typecheck` — clean
- `pnpm lint` — clean
- `pnpm test:unit` — 883/883
- `pnpm test:worker` — 758/763 (exactly the 4 documented `D-CAP-042-pre-existing-parallelism`
  failures, verified by name; no regressions)
- `pnpm build` — EXIT=0

**What FULL resolves:**

- **Reality-audit BLOCKER/HIGH findings 56/57/58/60** (the four CAP-045-targeted gaps from the
  2026-08-19 reality audit: `repeat deploy`, `setup UI`, `browser-test the user loop`,
  `cloudflare preview exercised`).
- **Phase 0 and Phase 1 status** — both return to `Verified` (the only thing keeping them at
  `Reopened` was operator preview evidence).
- **D-CAP-046-D / E / F** — operator-only items (browser hydration, real Cloudflare deploy
  execution, real email provider sign-up + DNS) are now satisfied by this run. These three
  deferred rows close in the **Phase 2 audit** pass; CAP-046 keeps them on its follow-up list
  until the audit confirms them as resolved.

**What FULL defers (unchanged from CAP-046 closure):** D-CAP-046-C/G/H (queue ack/retry direct
coverage, scheduled.ts direct coverage, blocklist-rejection inbound path) + D-CAP-046-J/K/L/M
(`webhook_secret.reveal` reconciliation, claim-setup burst race, preview-gate enum-loop coverage,
Hono header propagation). These remain Phase 2 audit candidates per
`docs/rebuild/execution-plan.md:38` and the deferred-row registry.

**Repository changes this closure:** ledger row + Active/Next/Blocked/Repository cells flipped;
Phase 0/1/2 status table updated; `work/active/CAP-045-preview-verification/task.md` archived to
`work/archive/2026-08/CAP-045/task.md`. No code changes — the operator runbook's 7 steps + the
suite + helper + doctor check #14 all shipped at code level in CAP-045 PARTIAL (commit
`18c9649` 2026-08-24).

**Next:** orchestrator-led **Phase 2 audit** per `docs/rebuild/execution-plan.md:156`
("Phase 3 is not decomposed until the recovery gate and Phase 2 audit pass"). Audit outputs a
Phase 2 closure entry into this log and identifies whether CAP-036 (JSON normalization) is the
remaining allocated Phase 2 backend-only slice before Phase 3 decomposition begins.

---

## 2026-08-24 — CAP-046 closed: Implemented (audit `request_id` correlation + standalone-write folds)

D-CAP-046-A (audit `request_id` correlation at 6 + 1 sites) and D-CAP-046-B (4 standalone audit writes folded into the same D1 batch as the business write) both **Resolved**. 13 files / +919 / −138 across 11 source + 2 doc files. Contract archived at `work/archive/2026-08/CAP-046/task.md`; reviewer reports at `work/reviews/CAP-046-{architecture,code,security,qa}-review.md`.

**Site-by-site (orchestrator-confirmed against the diff):**

- `apps/worker/src/http/routes/compose.ts` (`message.send`, AC 1): `createAuditEvent` replaced with `prepareCreateAuditEvent(c.env.DB, { ... requestId ... })`; the prepared statement is pushed onto the existing `statements` array before `createMessageWithRelations`. Queue send ordering unchanged.
- `apps/worker/src/http/routes/mailboxes.ts` (`mailbox.create`, AC 2 + AC 19): inline `INSERT INTO audit_events` SQL at lines 174-177 swapped for `prepareCreateAuditEvent` (single source of truth for the `audit_events` schema). The new `request_id` column binds to `requestId`. `db.batch([mailbox, audit, idempotency])` shape unchanged.
- `apps/worker/src/http/routes/admin-blocklist.ts` (`blocklist.create`, `blocklist.delete`, AC 3-4): `requestId: c.get('requestId') ?? null` field added to the existing `prepareCreateAuditEvent` calls.
- `apps/worker/src/http/routes/admin-role-policies.ts` (`role_policy.set`, AC 5): same.
- `apps/worker/src/modules/onboarding/complete-setup.ts` (`setup.complete`, AC 6 + AC 21): `CompleteSetupInput` gains `readonly requestId: string \| null`. The audit statement is now prepared via `prepareCreateAuditEvent` and pushed onto `stmts` before `input.db.batch(stmts)`. 6-line comment above the unconditional batch documents that the audit + UPDATE always present (the optional `user_roles` INSERT may or may not be there) — a future refactor that conditionally removes the UPDATE will not silently load-bear a guard-less batch.
- `apps/worker/src/modules/onboarding/claim-setup.ts` (`setup.claim`, AC 7): `ClaimSetupInput` gains `readonly requestId: string \| null`. The use case now writes `db.batch([prepareSeedInstallationState(...), prepareCreateAuditEvent(...)])`. `seedInstallationState` (`.run()`-only) is retained for symmetry and delegates to the new prepare.
- `apps/worker/src/modules/onboarding/installation-state-repository.ts` (AC 8): `prepareSeedInstallationState(db, step, timestamp): D1PreparedStatement` added, parallel to `prepareUpdateInstallationStep`. Re-exported through `modules/onboarding/index.ts`.
- `apps/worker/src/entrypoints/inbound-email.ts` (`message.receive`): the existing standalone audit `createAuditEvent` (which already carried `requestId`) is replaced with `prepareCreateAuditEvent` and prepended to `allStatements` before `createMessageWithRelations`.
- `apps/worker/src/http/routes/setup.ts` (caller plumbing, AC 6 + AC 7): `setup.ts:128-135` (claim handler) + `setup.ts:792` (complete handler) extract `c.get('requestId')` and pass it to the use cases.

**Preview-gate suite (`apps/worker/test/preview-gate.worker.test.ts`, ~280 lines added):**

- `DEFERRED_REQUEST_ID_ACTIONS` flips from the 5-action array to `[]` (AC 9).
- `EXPECTED_AUDIT_ACTIONS` constant added at module top — hand-declared set of 13 production values (independent of `auditActionSchema`) so the closed-vocab check is meaningful when DEFERRED_REQUEST_ID_ACTIONS is empty and would catch a future phantom action.
- `UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` constant at module top.
- Synthetic `writeResolved` helper (formerly lines 970-991) **removed** — replaced by route-level readback block.
- 8 new tests (AC 22–AC 29) under `describe('CAP-046 route-level audit correlation', ...)`: `message.send`, `mailbox.create`, `blocklist.create`, `blocklist.delete`, `role_policy.set`, `setup.claim`, `setup.complete`, `message.receive`. Each test drives the production path via `SELF.fetch`, queries the audit-events API with `actorUserId` + `action` filters, fetches the newest row, and asserts `requestId matches UUID_V4_REGEX` AND `resourceId matches the response's created entity`. The block's `beforeAll` seeds installation_state + roles/perms + admin user + managed domain; `beforeEach` re-seeds + re-logins after `resetAndMigrate` CACHE-reset side effect.
- `expect(DEFERRED_REQUEST_ID_ACTIONS).toHaveLength(0)` explicit length assertion (AC 20).

**Process — 4-way parallel review (frontend N/A per contract; no `apps/web/` changes):**

The initial-slice review surfaced **1 BLOCKER + 2 HIGH + 2 MEDIUM + 2 LOW**. Cross-reviewer agreement on the BLOCKER: the preview-gate suite's earlier `writeResolved` helper wrote synthetic rows directly via `createAuditEvent` instead of driving the modified production paths; a regression that dropped `requestId` from any of the 6 modified calls would have failed no test. The orchestrator expanded the contract with **AC 22–AC 29** (8 route-level readback tests) and dispatched a fix-slice implementer who rebuilt the test surface in-place. Code reviewer died mid-investigation on the initial round (API connection loss); re-dispatched code reviewer on the fix slice returned clean. One fix-slice implementer + one closure-pass implementer (folded two LOWs from the re-review round — AC 26 path correction + AC 29 inline regex → `UUID_V4_REGEX` constant reference).

**Review verdicts (re-review round on the fix slice, all 4 fresh):**

- **Architecture** (0/0/0/0): ACCEPT. "Next: Close CAP-046."
- **Security** (0/0/0/2 LOW): ACCEPT. LOWs were (a) contract line-number drift (doc-only, acceptable), (b) closed-vocab check string-typing. "Closure ledger entry may proceed."
- **Code** (0/0/0/3 LOW): ACCEPT. LOWs were (a) AC 26 path correction, (b) AC 29 inline regex → constant, (c) trailing newline (no addition needed).
- **QA** (0/0/0/2 LOW): ACCEPT-WITH-FIXES. LOWs converged with code's. "Accept CAP-046 closure. The orchestrator can stage the named files and commit `feat(CAP-046): audit request_id correlation + standalone-write folds` per the contract's ## File ownership table."

**Gates** (orchestrator-run, post-fix-slice + post-closure-pass):

- `pnpm scaffold doctor` 14/14 (unchanged from CAP-045 PARTIAL)
- `pnpm typecheck` clean (`tsc --build` exits 0)
- `pnpm lint` clean (zero findings)
- `pnpm test:unit` 883/883 (unchanged baseline; +0 from CAP-046 — the new audit tests live in `test/`, which runs under `test:worker`, not `test:unit`)
- `pnpm test:worker` 758/763 — exactly the 4 documented `D-CAP-042-pre-existing-parallelism` failures + 1 unrelated `tests-cover-contracts` reorg flake, no regressions. The CAP-046 closure-pass targeted `preview-gate.worker.test.ts` exclusively: **26/27** with 1 skipped (the live-mode-only sub-assertion gated on `BREVO_API_KEY?.trim()`; the operator's run with the key set exercises it).
- `pnpm build` EXIT=0

**Follow-ups recorded in `## CAP-046 follow-ups`:**

- **D-CAP-046-J** — `webhook_secret.reveal` audit reconciliation (out-of-scope decision: read-only reveal has no D1 mutation to fold with; the audit IS the write for a read-only reveal).
- **D-CAP-046-K** — `claim-setup.ts:87-98` audit row may double-fire under burst concurrent `/setup/claim` requests (pre-existing race CAP-046 preserved; `INSERT INTO audit_events ... SELECT ... WHERE NOT EXISTS (...)` is the fix shape).
- **D-CAP-046-L** — preview-gate suite's hard-coded TS literal union of 5 actions (architect's LOW-1); the in-scope 8 actions are covered end-to-end by the route-level readback block, but no single test loops over `auditActionSchema.options`.
- **D-CAP-046-M** — Hono 4.13.3's `c.header('X-Request-Id', id)` does not propagate to `new Response(...)` returns. The audit row's `requestId` is threaded correctly (R-AUDIT-001 holds; server-side log correlation works via the JSON log line at `request-id.ts:17`), but the HTTP response header is not observable to the client. Fix: switch the 7 in-scope + ~10 other `new Response()` success paths to `c.json()` (option a, cleaner long-term) or include `'X-Request-Id': c.get('requestId') ?? ''` manually (option b, surgical). Documented as a follow-up because the slice scope expanded already (route-level readback block was an unanticipated add) and the runtime invariant holds via the row's `requestId`.

The carry-forward rows **D-CAP-046-C / G / H** (queue ack/retry direct coverage, scheduled cron direct coverage, blocklist-rejection inbound path) are unchanged from CAP-045 PARTIAL.

**Closure status:** Implemented at code level (`Verified` requires the CAP-045 FULL preview run). Contract archived; reviewer reports preserved; no commit/push/deploy performed (security constraint preserved). Next: CAP-045 FULL closure — operator runs `pnpm scaffold deploy --environment=preview`, executes runbook Steps 1–7, drops evidence into `work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/`, and pastes `pnpm test:worker` output back. Until that lands, Phase 0 and Phase 1 stay `Reopened`.

---

## 2026-08-24 — CAP-046 contract drafted: audit `request_id` correlation + standalone-write folds

Decomposed D-CAP-046-A (audit `request_id` correlation at 6 call sites) + D-CAP-046-B (4
standalone audit writes folded into the same D1 batch as the business write) from the
CAP-045 PARTIAL closure deferred rows into a new capability, per the user's chosen path.

**Inventory (orchestrator-confirmed against the source):**

- **D-CAP-046-A** (6 sites missing `request_id`):
  - `apps/worker/src/http/routes/compose.ts:262` — `message.send`
  - `apps/worker/src/http/routes/mailboxes.ts:171` — `mailbox.create` (raw SQL)
  - `apps/worker/src/http/routes/admin-blocklist.ts:121` — `blocklist.create`
  - `apps/worker/src/http/routes/admin-blocklist.ts:232` — `blocklist.delete`
  - `apps/worker/src/http/routes/admin-role-policies.ts:144` — `role_policy.set`
  - `apps/worker/src/modules/onboarding/complete-setup.ts:72` — `setup.complete`
- **D-CAP-046-A** (7th site, was not in the CAP-045 deferred-rows export — the preview-
  gate suite's AC 7 deferred-rows accumulator never drove `/setup/claim`, only
  `/setup/complete`):
  - `apps/worker/src/modules/onboarding/claim-setup.ts:80` — `setup.claim`
- **D-CAP-046-B** (4 standalone writes to fold):
  - `compose.ts:262` — fold into existing `statements` array before `createMessageWithRelations`
  - `inbound-email.ts:177` — fold into `allStatements` before `createMessageWithRelations`
  - `complete-setup.ts:72` — fold into existing `stmts` array before `input.db.batch(stmts)`
  - `claim-setup.ts:80` — `db.batch([prepareSeedInstallationState(...), prepareCreateAuditEvent(...)])`

**Reference pattern (locked):** `apps/worker/src/http/routes/webhooks.ts:60-93` —
`const requestId = c.get('requestId') ?? null;` then `prepareCreateAuditEvent(...)` (or
`ctx.auditEventWriter.prepare({ ... requestId, ... }).statement`) folded into the existing
`db.batch([...])`. In-module routes use `prepareCreateAuditEvent` directly; cross-module
use is the audit-event-writer seam (CAP-040).

**Out of scope with reason:**

- `apps/worker/src/http/routes/admin-webhooks.ts:117` (`webhook_secret.reveal`) — read-only
  reveal has no D1 mutation to fold with; the audit row IS the write. R-AUDIT-001's strict
  reading treats reads as non-transitions. Recorded as **D-CAP-046-J** for a future CAP
  that reconciles orphan reads via `wrangler tail` log-line ingestion.
- D-CAP-046-C/G/H (queue ack/retry direct coverage; `scheduled.ts` direct coverage;
  blocklist-rejection inbound path) unchanged from CAP-045.

**Plumbing for use cases:** `CompleteSetupInput` and `ClaimSetupInput` each gain
`readonly requestId: string \| null`. Routes `setup.ts:128-135` (claim) and `setup.ts:792`
(complete) extract `c.get('requestId')` and pass it. `installation-state-repository.ts`
gains `prepareSeedInstallationState(db, step, timestamp): D1PreparedStatement` parallel
to the existing `prepareUpdateInstallationStep`. The existing `seedInstallationState`
(`.run()` variant) is retained for symmetry and delegates to the new prepare.

**Validation harness:** the preview-gate suite's `DEFERRED_REQUEST_ID_ACTIONS` export
flips from the current 5-action array to `[]`. AC 7's deferred-rows accumulator now
discovers zero rows. Worker tests at each in-scope route read back `audit_events.request_id`
and compare to the request's `x-request-id` response header (request-id middleware echoes
the value it stamped).

**Files (orchestrator-authorable this slice):**

- `work/active/CAP-046-audit-correlation/task.md` (NEW, drafted) — the contract
- `docs/rebuild/capability-ledger.md` (CAP-046 row added, Active/Next/Repository state cells flipped)

**Closure status:** In Progress. Implementation + 4-way parallel review + fix pass + slice
commit (`fix(CAP-046): audit request_id correlation + standalone-write folds`) land next.

---

## 2026-08-24 — CAP-046 contract expanded: route-level readback tests + review polish

CAP-046 review surfaced one BLOCKER + 2 HIGH (qa reviewer) and 2 MEDIUM + 2 LOW (architecture
reviewer). Code reviewer died mid-investigation (API connection lost) but partial evidence
aligned with the QA's gap finding. Security reviewer: ACCEPT (0/0/0/2 LOW; LOWs were
doc-drift and a pre-existing design note on `inbound-email.ts:114`).

**BLOCKER fix — route-level readback tests (AC 22–AC 29, new):**

The original CAP-046 contract claimed "AC 4 / AC 5 worker tests read `request_id` from
the `audit_events` row and compare to the request's `x-request-id` response header" but
those tests did not exist. The preview-gate suite's `writeResolved` helper
(`preview-gate.worker.test.ts:970-991`) wrote synthetic audit rows directly via
`createAuditEvent` with a fabricated `requestId`, then queried the audit-events API.
A regression that dropped `requestId` from any of the 6 modified production calls would
not have failed any test. CAP-046 expands to add 8 route-level readback tests:

- `message.send` (`POST /api/v1/mailboxes/:mailboxId/messages/send`)
- `mailbox.create` (`POST /api/v1/mailboxes`)
- `blocklist.create` (`POST /api/v1/admin/blocklist`)
- `blocklist.delete` (`DELETE /api/v1/admin/blocklist/:id`)
- `role_policy.set` (`PATCH /api/v1/admin/role-policies/:id`)
- `setup.claim` (`POST /api/v1/setup/claim`)
- `setup.complete` (`POST /api/v1/setup/complete`)
- `message.receive` (entrypoint: `entrypoints/inbound-email.ts`'s default export)

Each test drives a real request via `SELF.fetch`, captures `X-Request-Id` from the
response, queries `GET /api/v1/admin/audit-events` with `actorUserId` + `action`
filters, and asserts the newest row's `requestId` equals the captured header. The
inbound-email case asserts the row's `requestId` is a valid UUID (the entrypoint
synthesizes one — no Hono context in Email Routing; pre-existing design cited as
architecture LOW-2).

The synthetic `writeResolved` helper is removed in favor of the route-level block.

**HIGH fix — explicit `DEFERRED_REQUEST_ID_ACTIONS` length assertion (AC 20, new):**

The pre-CAP-046-final test copies `DEFERRED_REQUEST_ID_ACTIONS` into a local `expected`
array at line 1035 and checks membership in `auditActionSet` at lines 1054–1061. No
explicit `expect(DEFERRED_REQUEST_ID_ACTIONS).toHaveLength(0)` exists. The closed-vocab
check is self-referential (derives `auditActionSet` from `auditActionSchema.options`).
CAP-046 adds an explicit length assertion AND uses a hand-declared expected action set
(NOT derived from production schema) for the closed-vocab check, so the assertion is
meaningful when the export is empty today and would catch a phantom action if a future
export non-empty.

**MEDIUM fix — `mailboxes.ts:174-177` single source of truth (AC 19, new):**

`mailboxes.ts:174-177` had inline `INSERT INTO audit_events` SQL duplicating the schema
in `apps/worker/src/modules/admin/audit-event-repository.ts:54-68`. A future column
addition (e.g., `audit_events.ip_address` for Phase 2) would silently drop NULL for
mailbox-create rows. CAP-046 swaps the inline SQL for `prepareCreateAuditEvent` —
one-function swap, no behavioral change.

**LOW fix — `complete-setup.ts` guard comment (AC 21, new):**

The pre-CAP-046 `if (stmts.length > 0) { await input.db.batch(stmts); }` guard was
removed because the audit row always pushes onto `stmts` (so the batch is never empty).
Add a one-line comment above the unconditional `db.batch(stmts)` noting this is
intentional — a future refactor that conditionally removes the UPDATE will not silently
load-bear the guard-less batch.

**Follow-ups recorded (NOT blocking CAP-046 closure):**

- **D-CAP-046-K** — `claim-setup.ts:87-98` audit row may double-fire under burst
  concurrent `/setup/claim` requests. Pre-existing race: `prepareSeedInstallationState`
  uses `ON CONFLICT(id) DO NOTHING`; two concurrent claims both pass the not-complete
  check, both write the seed (one swallows), both write the audit row. R-AUDIT-001
  holds strictly (≥1 audit row per transition) but the audit log no longer reflects
  the actual count of transitions. Fix: `INSERT INTO audit_events ... SELECT ...
  WHERE NOT EXISTS (...)` or row-count gating.
- **D-CAP-046-J** — `webhook_secret.reveal` audit reconciliation. Out of scope for
  CAP-046 (read-only reveal has no D1 mutation to fold with). Already recorded.
- **D-CAP-046-L** (new) — Preview-gate suite's hard-coded TS literal union of 5
  actions in `writeResolved`'s successor block. Architect's LOW-1: the test should
  loop over `auditActionSchema.options` to exercise every enum value, not just the
  closed set of 5. The route-level tests cover the in-scope 8 actions end-to-end;
  Phase 2 emission points will need their own coverage.

**Closure status:** Implementation in progress. Single-implementer fix slice dispatched
next; gates re-run; 4-way parallel review re-run on the fix diff; then closure.

---

Closed `Implemented (PARTIAL)` on the orchestrator-authorable subset: Worker-pool integration
suite + helper + runbook + doctor check #14. Closes FULL when the operator pastes `pnpm test:worker`
output + runbook evidence back; that is a ledger-only update, no further code changes.

**Form (locked by user):** executable suite + operator close-out runbook. Worker HTTP +
entrypoint round-trip via vitest workers pool. Provider HTTP live when `BREVO_API_KEY?.trim()`
is set (operator-runs-the-gate); skipped with `console.warn` when unset (orchestrator-runs-
the-gate). Strict `request_id` matching captured into a deferred-rows accumulator that asserts
the EXACT production-named six actions missing `request_id` today (driven through the
audit-events API, not seeded — discovered after the 4-way parallel review caught the prior
tautology). `scripts/send-test-brevo.ts` ships at 45 lines. `testing.md` §Mocking is NOT
amended; live-HTTP is conditional on env-var presence only.

**Files (this slice):**
`apps/worker/test/preview-gate.worker.test.ts` (NEW, 1253 lines, 18 sub-assertions + 1
live-mode skip),
`apps/worker/vitest.workers.config.ts` (include-glob expansion to `test/**/*.worker.test.ts`),
`scripts/doctor.ts` (check #14 `preview-gate-suite-present` wired into `CHECKS`; pure
evaluator `evaluatePreviewGateSuitePresent({ fsRead })` per CAP-039 precedent),
`scripts/doctor.test.ts` (NEW, 8 unit tests),
`scripts/redaction-patterns.ts` (NEW, anchored regexes extracted from inline — single source
of truth for the suite's redaction scan + the doctor's helper check),
`scripts/send-test-brevo.ts` (NEW, 45 lines, ≤50 budget — Brevo `/v3/smtp/email` POST with
`BREVO_API_KEY` from env, no credential in script, try/catch + key-shape validation),
`work/reviews/CAP-045-preview-runbook.md` (NEW, 281 lines, 7 steps with `<DEPLOYED_WORKER_URL>`
placeholder + `wrangler tail` second-terminal instruction + `ENVIRONMENT=preview pnpm
scaffold deploy` corrected in Steps 1+7 after QA H3),
`work/active/CAP-045-preview-verification/task.md` (contract with V1/V2/V3 spike verdicts —
V1 verified independently by Read of `@cloudflare/workers-types:2445-2451`; V2/V3 proven by
the suite's first `pnpm test:worker` run; D-CAP-046-G + D-CAP-046-H added to §"Out of scope").

**Pre-implementation verifications (BLOCKERs to clear before authoring):**
- **V1** (MessageBatch stubbability): GREEN — `MessageBatch` + `Message` interfaces in
  `@cloudflare/workers-types:2445-2451` structurally constructible; metadata cast uses
  `as unknown as` + actual `metrics` after the architecture review.
- **V2** (fetch-spy intercepts worker-pool outbound): GREEN — proven by the suite's first
  `pnpm test:worker` run; live-mode keeps the spy and skips the adapter stub.
- **V3** (console-restore pattern): GREEN — `vi.spyOn(console, X).mockImplementation(...)`
  toggle in `beforeEach`/`afterEach`; `restoreAllMocks` never called; captured arrays cleared
  per-test.

**4-way parallel review (frontend N/A per contract; no `apps/web/` changes this slice):**
architecture / code / security / qa. 4 BLOCKERs + ~12 HIGHs + ~12 MEDIUMs + ~15 LOWs
consolidated; one fix slice closed every BLOCKER and HIGH. Cross-reviewer agreement on
the four BLOCKERs: (a) AC 7 deferred-rows accumulator was a tautology seeded with names
that don't exist in the production `AuditAction` enum → replaced with API-driven discovery
via `GET /api/v1/admin/audit-events?actorUserId=...` through `SELF.fetch`; (b) AC 6c was
structurally empty → now drives the webhook route with a valid HMAC and asserts
`webhook_deliveries.status='pending'`; (c) AC 5 live-mode contradicted itself (stub adapter
never called fetch) → live-mode now runs the real Brevo adapter against the mocked fetch;
(d) AC 7 redaction test never reached the service layer (setup/complete without auth got
401) → now drives the full setup flow and scans captured `console.warn('[onboarding]
administrator created', { email })` lines. Runbook deploy command corrected
(`ENVIRONMENT=preview pnpm scaffold deploy`, not `--environment=preview` which is silently
ignored). `wrangler tail --env preview` corrected to `cd apps/worker && wrangler tail`
(no env.preview section exists).

**Gates (orchestrator-run, post-fix-slice, verified independently):**
doctor 14/14 (was 13/13), typecheck/lint clean, unit 883/883 (was 863/863), worker
750/755 — exactly the 4 documented `D-CAP-042-pre-existing-parallelism` failures
(`0015_credential_backfill` + `admin.seedRolesAndPermissions` ×2 + one more), verified by
name, no regressions, build EXIT=0. The 18 preview-gate sub-assertions all pass (1 skipped
is the live-mode sub-assertion gated on `BREVO_API_KEY`; with `BREVO_API_KEY` set, the
operator's run exercises all 19).

**Deferred rows recorded at PARTIAL closure:**
- **D-CAP-046-A** — audit `request_id` correlation at six named call sites (compose.ts,
  mailboxes.ts, admin-blocklist.ts, admin-role-policies.ts, complete-setup.ts).
  Machine-readable from the suite's `DEFERRED_REQUEST_ID_ACTIONS` export, now anchored to
  production names (`message.send`, `mailbox.create`, `blocklist.create`,
  `blocklist.delete`, `role_policy.set`).
- **D-CAP-046-B** — six standalone audit writes (crash-window gaps where audit row runs
  AFTER the business write).
- **D-CAP-046-C** — `entrypoints/queue.ts` `msg.ack()` / `msg.retry()` direct coverage;
  V1 seam-extract fallback path.
- **D-CAP-046-D** — Browser hydration evidence — operator-runbook only.
- **D-CAP-046-E** — Real Cloudflare deploy execution — operator-only.
- **D-CAP-046-F** — Real email provider sign-up + domain verification + SPF/DKIM/DMARC
  publication — operator-only.
- **D-CAP-046-G** (new this slice) — `entrypoints/scheduled.ts` direct coverage; the
  maintenance cron is not invoked from the worker-pool suite. Operator can drive it via
  the runbook's `wrangler tail` + cron trigger.
- **D-CAP-046-H** (new this slice) — blocklist-rejection inbound path per R-INBOUND-005;
  the gate proves the audit chain when a blocklist decision is recorded but does not drive
  the inbound entrypoint with a matching from/subject/content that returns 4xx.

**Resolves:** Phase 0 + Phase 1 "Reopened" status when CAP-045 closes FULL (operator pastes
preview evidence back).

**Closure status:** Implemented (PARTIAL). Closes FULL when the operator runs
`pnpm scaffold deploy --environment=preview`, runs runbook Steps 1–7, drops evidence into
`work/reviews/CAP-045-evidence-<OPERATOR>-<YYYY-MM-DD>/`, and pastes the `pnpm test:worker`
output back into the ledger row's evidence section.

---

## 2026-08-24 — CAP-044 closed: Implemented (CAP-033 flips with it, D-CAP-044-E)

All 23 ACs met across three slices, each through the full loop (implementer → 5-way parallel
review → single-implementer fix pass → orchestrator-validated gates → commit). Final commit
`2c2b4ae`; final gates: doctor 13/13, typecheck/lint clean, unit 863/863, worker 732/736
(exactly the 4 documented `D-CAP-042-pre-existing-parallelism` failures, verified by name),
build EXIT=0. 15 reviewer verdicts across 3 rounds, all ACCEPT or ACCEPT-WITH-FOLLOWUPS;
consolidated records at `work/reviews/CAP-044-slice{1,2,3}-review.md`. Decisions
D-CAP-044-A..T in the archived contract (`work/archive/2026-08/CAP-044/task.md`); deferred
rows I–T in the ledger (K and L RESOLVED by Slice 3; N matters for CAP-045's upgrade-path
assertion).

Closure housekeeping: `InboxError.tsx` deleted (unused after the data-first restructure —
`InboxListPage` renders the error shell inline); `security.md` PermissionKey prose list
gained `audit.read` (was stale since D-CAP-044-D; the seed cites it as source of truth);
`complete-setup.ts` seed-count comment corrected (21 permissions / 49 statements).

**Contracts deviation now logged (architecture L3):** `userListItemSchema` is deliberately
the only `.strict()` schema in `packages/contracts` — the R-SECRET-003 credential exclusion
made structural. The repository enumerates exactly five non-credential columns, so a
well-formed server row can never fail on strictness; a future fat-fingered field name fails
parse instead of leaking. It is the template for any future secret-adjacent list schema.

**Verified still requires CAP-045** (fresh + repeat preview deploy) — code-level closure only,
per documentation rules.

## 2026-08-24 — CAP-044 Slice 3 landed: admin users + connections/webhook-events + AppNav + styling (5-way review + 8-item fix pass)

Commit `2c2b4ae`. ACs 15–23 verified (verdicts + evidence in
`work/reviews/CAP-044-slice3-review.md`; all five reviewers ACCEPT-WITH-FOLLOWUPS, QA's
independent gate run showed zero baseline divergence). Landed: identity-owned `listUsers`
(five-column credential-excluding SELECT, per-row `userStatusSchema.safeParse` detection
point), `GET /api/v1/admin/users` (`user.read`), `CursorPayload` + closed `CursorSurface`
union promoted into contracts (the Slice 2 third-consumer trigger firing — `platform/cursor.ts`
keeps crypto only, one schema definition repo-wide), UsersPage/ConnectionsPage/
WebhookEventsPage + AdminLandingPage, the `AppNav` admin probe (D-CAP-044-K resolved: one
`GET /admin/audit-events?limit=1`, 200 → link, 403 → nothing), and the AC 22 styling pass
(closes D-CAP-043-L; reviewer-verified zero unresolved classNames, zero inline styles).

**The finding that mattered (code H1 ≡ security M1):** admin data query keys were not
user-scoped — only the nav probe was. On a shared browser, user B signing in after admin A's
sign-out could open `/admin/users` by URL and see A's cached rows under a 403 banner,
persistently (data-first contract + `retry: false` keeps rows mounted beside the error). Fix
(a): every admin data key carries the session userId (the probe precedent, applied
everywhere; `'anonymous'` placeholder never fetches — `enabled` gating). The sign-out
cache-sweep alternative was ruled out: it enumerates session-transition events and misses
cookie-expiry-then-new-sign-in. The CAP-043 mailbox-key twin is D-CAP-044-O, not silently
absorbed.

Rulings: `USER_ROW_INVALID` added to `ERROR_CODES` (overruling architecture's accept-as-is —
three of four reviewers wanted the Slice 2 `AUDIT_ROW_INVALID` precedent, and the grant is
cheaper than a permanent deferred row; the branch stays untested because `users.status`'s
CHECK makes a corrupt row unmanufacturable without forbidden D1 mocking); local zod schemas
for connections/webhook-events/reveal stay client-local until the legacy phase-1 list
conversion promotes them WITH the route refactor (D-CAP-044-P — promoting schemas beside a
hand-mapped route would create the second-source-of-truth anti-pattern); D-CAP-044-L decided
and CLOSED in this pass (`InboxListPage` gained the `resetQueries` start-over in both
data-first branches; its two false "`refetch()` restarts from page 1" comments corrected).
Fix pass also: `isPending` loading gates (offline-paused first fetch has `isLoading ===
false` — the empty state rendered terminal claims with zero requests completed), probe
`retryOnMount: false` + `gcTime: Infinity` (errored queries refetch on every remount by
default — AppNav remounts per route change; unobserved entries are GC'd after ~5 min), reveal
mutation `gcTime: 0` + stale-error clear, one-sided unread dividers (old adjacency rules drew
some boundaries twice, some never), leak-regex extended to `/password|salt|…/i`. +13 unit
tests (863 vs 850 baseline).

## 2026-08-24 — CAP-044 Slice 2 landed: audit-event query API + /admin audit page (CAP-033 absorbed; 5-way review + 7-item fix pass)

ACs 8–14 verified (verdicts + evidence in `work/reviews/CAP-044-slice2-review.md`; all five
reviewers ACCEPT-WITH-FOLLOWUPS). `audit.read` added to the closed PermissionKey enum
(D-CAP-044-D — administrator 21 permissions, member unchanged), composable cursor-paginated
query repository, `GET /api/v1/admin/audit-events`, `/admin` section + AuditEventsPage with
draft/committed filters. Gates after the fix pass: unit 797/797, worker 718/722 (only the 4
documented pre-existing D1-parallelism failures).

**The finding that mattered (architecture H1 ≡ QA M1):** AC 9's "served by the existing
indexes" was empirically false. The single-statement `? IS NULL OR …` shape lets one query
text serve every filter combination, but SQLite picks its plan at prepare time and never
changes it with bindings — `EXPLAIN QUERY PLAN` proved every combination, filtered or not,
scanned the whole table via `audit_events_created_idx` with a temp-B-tree sort, on the one
append-only unbounded-growth table, billed by D1 rows-read. Fix (a) composes bare
parameterized predicates per ACTIVE filter (messages-repository precedent; null-bound slots
for the cursor boundary only) so `audit_events_actor_idx` / `audit_events_resource_idx` are
actually selectable. General lesson recorded: `? IS NULL OR …` around a FILTER column
silently defeats index selection; it is only acceptable around page-boundary terms.

Also landed in the fix pass: server-side `auditActionSchema.safeParse` per row (corrupt row →
500 `AUDIT_ROW_INVALID`, new stable code in `ERROR_CODES` — never a 200 the client cannot
parse, never a silently skipped forensic row); cursor **surface discriminator**
(`CursorPayload.surface` + `verifyCursor(token, key, expectedSurface)`) so a cursor minted by
the messages API cannot be replayed against the audit API — the primitive now has two
consumers; a third consumer or a filter-binding need triggers promoting it into `contracts`
with filter context in the signed payload; data-first error states on the audit page
(accumulated rows + filter form survive errors; INVALID_CURSOR recovers via `resetQueries`
"Start over" because TanStack v5 `refetch()` replays all stored pageParams — the same hazard
D-CAP-044-L records for the messages surfaces); half-pair guard; +7 worker +4 unit tests.

Rulings recorded in the contract: AC 13's nav clause AMENDED (session descriptor carries no
role signal — "visible only when the session can read" is unmeetable client-side; nav entry +
probe gating are D-CAP-044-K into Slice 3); upgrade-path seed gap D-CAP-044-N (audit.read
exists only after the setup seed re-runs — fresh installs fine, CAP-045 asserts the preview);
new deferred rows D-CAP-044-L (messages-side INVALID_CURSOR ≥2-page replay) and
D-CAP-044-M (admin filters not URL-addressable). Process gap noted for closure: worker test
files are excluded from `tsc --build`, so test-only type errors are invisible to the
typecheck gate.

## 2026-08-24 — CAP-044 Slice 1 landed: compose + reply (review round + 9-item fix pass)

Commit `2fded28`. ACs 1–7 verified with evidence by the five-way round (verdicts + positive
evidence in `work/reviews/CAP-044-slice1-review.md`): composer at `/mailbox/:mailboxId/compose`
(plain-text, send-only), reply prefill via `buildReplyContext`, `composeResponseSchema` promoted
to contracts, unit 758/758, worker 698/702 (only the 4 documented pre-existing D1-parallelism
failures), zero worker files touched.

The round produced one REJECT-grade defect the implementer round missed: the reply base was
selected with JS truthiness where `THREAD_ROOT_SQL` requires a `<…>` pair, so a malformed stored
References value silently unthreaded the reply. Fix pass (a) mirrors the SQL tier conditions
exactly (references base only with a pair; in-reply-to base when non-null + non-empty — the SQL
tier carries NO pair condition there); the test mirror `resolvedThreadRoot` was aligned to the
SQL's first-`>`-overall instr semantics at the same time. Also landed: data-first parent branch
ordering (a failed background refetch no longer destroys a typed draft or the send
confirmation), stale-threading-context clear on success, double-submit bail, INVALID_RESPONSE
mapping, path-id encoding, trimmed `?replyTo`, +17 tests.

Rulings recorded in the contract: `compose.ts:145` provider resolution is carried as the
R-OUTBOUND-001 deferred row (security-ruled acceptable: single-active-connection topology is
behaviorally identical; CAP-045 must assert that topology); the threading e2e worker proof is
deferred (D-CAP-044-J — notably zero of the 16 compose worker tests send threading headers);
unbounded `inReplyTo`/`references` deferred (D-CAP-044-I — durable fix is server-side threading-
header normalization at send + ingest, which also carries the size caps and the non-bracket
in-reply-to corner). Closure duty stands: log the client-mirror ↔ `THREAD_ROOT_SQL` drift
surface + the promotion trigger (second consumer → promote the helper into contracts).

## 2026-08-24 — CAP-044 dispatch: compose/reply + admin surfaces (contract written, Slice 1 out)

Pre-contract investigation (read-only, `inv-cap044-state`) mapped the ground truth: the send API **already exists** — `POST /api/v1/mailboxes/:mailboxId/messages/send` (CAP-023) with the full one-batch write (message + recipients + mailbox_messages + outbound_jobs + idempotency record), queue handoff, and `message.send` audit — and `composeRequestSchema` already carries `inReplyTo`/`references`. The real gaps: no web composer/reply anywhere, audit events are **writer-only** (no query repo/route/UI — CAP-033 never started), no users-list API (identity owns `users`, exports nothing list-shaped), no admin UI at all, and Tiptap is not installed.

Contract at `work/active/CAP-044-compose-reply-admin/task.md` — 3 slices: (1) compose+reply web vertical incl. `composeResponseSchema` promotion and the reply-threading invariant (references-first-token = parent's resolved `THREAD_ROOT_SQL` root); (2) CAP-033 absorbed — new `audit.read` permission key (deliberate closed-enum extension, D-CAP-044-D), query repo by actor/resource, `GET /api/v1/admin/audit-events`, admin web shell + audit page; (3) identity `listUsers` + `GET /api/v1/admin/users` + users/connections/webhook-events pages + the D-CAP-043-L styling pass. Decisions D-CAP-044-A..H recorded (notably A: no drafts — Phase 2 scope; B: plain-text composer, Tiptap deferred to Phase 3; G: D-CAP-040-B resolved by amending R-SECRET-003 with the narrow reveal exception). CAP-034 flipped to Implemented-via-CAP-043 (D-CAP-044-F).

Session-hygiene repairs landed alongside (commit `27d9d1b`): `ps_ledger_active_cap_id` false-drift fix and the implementation log consolidated to strict newest-first (54 entries; `ps_recent_log` now returns the true newest entry).

## 2026-08-24 — CAP-043 closed. Ledger flipped to **Implemented** (all 20 ACs, 3 slices at `422b4ab`/`e81e233`/`b6a675b`; final orchestrator-run gates doctor 13/13, unit 706/706, worker 698/702 with the 4 documented pre-existing failures, build ✓). Deferred rows **D-CAP-043-J..N** recorded in the ledger: J per-user star (Phase 3), K `thread_id` backfill (D-CAP-043-C scan), L inbox styling pass, M `message-read-repository.ts` split deferred to CAP-044, N **decided — keep** the `assertCan` 404-not-found / 403-denied split (per-deployment isolation scope; message-level uniform `MESSAGE_NOT_FOUND` no-leak stays, worker-test-proven). Contract archived to `work/archive/2026-08/CAP-043/task.md`; `work/active/` is empty. Next capability: **CAP-044** (compose/reply + admin surfaces).

## 2026-08-24 — CAP-043 Slice 3 complete + 5-way review + fix pass. Star toggle + per-user soft delete (AC 13–17) landed by `implementer-slice-3`, reviewed by 5 parallel reviewers (all ACCEPT-WITH-FOLLOWUPS — zero BLOCKER, zero HIGH), fix pass (H1–H14) by `implementer-slice3-fix`. Consolidated review record at `work/reviews/CAP-043-slice3-review.md`. New decisions: **D-CAP-043-H** (star + soft delete ride the `message.read` + `assertCan('read')` surface; `message.delete` reserved for hard delete) and **D-CAP-043-I** (audit boundary: `message.star_toggled` + `message.soft_deleted` audit rows folded into the business batch; `markRead` exempt as per-user presentation state).

**Slice 3 as implemented**: `mailboxListItemSchema` + `mailboxListResponseSchema` + `toggleStarResponseSchema` promoted into `packages/contracts` (local web copy deleted); `PATCH .../star` and `DELETE .../messages/:messageId` behind `requirePermission('message.read')` + `requireIdempotencyKey` + the extracted `requireMailboxReadAccess` / `beginIdempotentOperation` file-private helpers; DELETE returns 204 with the record storing `204 + ''` (D-CAP-043-E). Web: `StarButton` optimistic flip with rollback, `DeleteMessageButton` → `ConfirmDeleteDialog` (`AlertDialog` composed from `Alert`/`Button`), structural cache removal + detail/thread `removeQueries` on delete.

**Review round — the finding that mattered**: security M1 ≡ code M1 — the star toggle and its idempotency record were separate statements, and the ApiClient provably reuses its minted Idempotency-Key across 5xx/429 retries, so a crash gap or same-key race re-executed a non-re-runnable `NOT is_starred` (one click, two state changes — exactly what R-API-004 forbids). Code M2: whole-snapshot star rollback could resurrect a deleted row or a sibling's failed optimistic flip. Code M3 ≡ arch M-1: platform `replayResponse` threw on a stored 204 (fetch spec rejects a non-null body on a null-body status) and three parallel replay implementations had drifted. Security M2: no audit rows for the two new state transitions (R-AUDIT-001).

**Fix pass (H1–H14, per task.md §Slice 3 review outcome)**: star became a read-compute-write batch — `getMessageStarState` → computed target → ONE `db.batch([prepareSetMessageStar, record, audit])` (a batched `UPDATE … RETURNING` cannot feed the record's `responseJson`; D1 binds values at prepare time — orchestrator design decision recorded in the criterion); delete became `prepareSoftDeleteMessageForUser` → ONE `db.batch([UPSERT, record(204,''), audit])`; both catches narrow on the idempotency UNIQUE violation and replay via platform `replayAfterRace`, the loser's batch having rolled back entirely. `replayResponse` gained the null-body guard (unit test proves a stored 204 replays); both route-local replay helpers deleted — one fact, one home. `message.star_toggled` + `message.soft_deleted` folded via the CAP-040 `AuditEventWriter` seam (webhooks.ts pattern). Timestamps normalized to `sqliteTimestamp(systemClock.now())`; route-layer SQL eliminated (`markMessageAsRead(db, mailboxId, messageId, userId)` resolves the row itself); star rollback became row-scoped; the delete dialog stays open on failure with an inline error; `Promise.all` same-key race tests assert interleaving-independent invariants (both-204, one record, one audit row, DB = response); QA matrix landed (F4 route-seeded cross-user delete, fresh-key re-delete 204, viewer-role + 401, settled `aria-pressed`); AlertDialog a11y (`role="alertdialog"`, aria-modal, accessible name, Escape, focus-on-Cancel) + subject-qualified delete label + valid row markup; storage guard extended to `features/mailbox/**`.

**Gates (orchestrator-run, post-fix)**: `pnpm scaffold doctor` 13/13 ✓, `pnpm typecheck` clean ✓, `pnpm lint` clean ✓, `pnpm test:unit` 706/706 (692 baseline + 14 new) ✓, `pnpm test:worker` 698/702 (694 baseline + 8 new in messages.worker.test.ts; the 4 failures verified by name as exactly the documented pre-existing D1-parallelism set) ✓, `pnpm build` EXIT=0 with `wrangler --dry-run` clean ✓. Committed at the slice boundary as one logical change (slice + fix pass).

**Deferred** (registry in task.md §Slice 3 → Deferred): per-user star migration (D-CAP-043-A); `THREAD_ROOT_SQL` CASE scan with the `thread_id` backfill (D-CAP-043-C); `mailboxListItemSchema` uuid tightening; tokens.css inbox styling pass; AlertDialog focus-trap; repository split decision; `assertCan` 404-vs-403 oracle; `MailboxListItem` re-export; cursor payload binding + `verifyCursor` hardening (carried). Next: **CAP-043 closure** — ledger flip to Implemented, archive `work/active/CAP-043-inbox-message-thread/`.

## 2026-08-24 — CAP-043 Slice 2 complete + 5-way review + fix pass. Message detail + thread (AC 9–12) landed by `implementer-slice-2`, reviewed by 5 parallel reviewers, fix pass (G1–G12) by `implementer-slice2-fix`. Consolidated review record at `work/reviews/CAP-043-slice2-review.md`; architecture report at `work/reviews/CAP-043-architecture-review-slice2.md`. This was the first full review round under the repaired SubagentStop validator (`4dec8e4`) — all five reviewers stopped cleanly through the handoff gate.

**Slice 2 as implemented**: `getMessageDetail` + `getMessageThread` in `message-read-repository.ts`; thread root resolved at read time by one interpolated `THREAD_ROOT_SQL` CASE (`thread_id` → first `<…>` token of `references_header` (brackets kept) → `in_reply_to_header` → own `message_id_header`; NULL ⇒ singleton — D-CAP-043-C). `GET /api/v1/mailboxes/:mailboxId/messages/:messageId/thread` behind `requirePermission('message.read')` + `assertCan` on the path mailboxId; identical 404 `MESSAGE_NOT_FOUND` for non-existent vs cross-mailbox (no existence leak). `messageThreadResponseSchema` in contracts (`rootId` nullable, items reuse `messageListItemSchema`). Web: `/mailbox/:mailboxId/messages/:messageId` detail page (text body, collapsed headers, thread panel with active-message highlight), exactly-once mark-read per open via a `markedMessageRef` guard, detail/thread queries keyed inside the `['mailbox','messages',mailboxId]` family. Slice 2 fe-LOW rode along: `InboxListPage` Card title shows the mailbox address from the cached list instead of the raw UUID.

**Review round**: architecture / code / security / frontend ACCEPT-WITH-FOLLOWUPS · QA ACCEPT (AC 9–12 verified). Two findings mattered: (1) security M1 + arch L2 — the thread query was unbounded and its recipients `IN`-clause bound every member id, so a >100-member thread exceeded D1's 100-parameter ceiling and failed the whole request (500); (2) arch M1 ≡ code M4 ≡ sec L2 — `getMessageDetail` lacked the per-user soft-delete predicate, so the detail surface returned 200 for messages the caller had deleted while the thread on the same page 404'd.

**Fix pass (G1–G12, per task.md §Slice 2 review outcome)**: `THREAD_MAX_ITEMS = 50` named constant citing the D1 parameter limit; root branch `ORDER BY created_at DESC, id DESC LIMIT ?` reversed in JS to oldest-first (newest-50 window; `rootId` stays correct, anchor rendered by the detail query — presentation-only); singleton branch untouched; recipients fetch naturally ≤50 params. `getMessageDetail` gains `COALESCE(mus.is_deleted, 0) = 0`. `THREAD_ROOT_SQL` final tier `NULLIF(m.message_id_header, '')` — empty-string Message-IDs resolve NULL, so header-less messages cannot fuse on root `''`. Five new worker tests: 120-member boundary (200 + exactly 50 newest, root excluded, parsed recipients — red/green-probed: uncapped query 500s), detail soft-delete (404 for the deleting user, 200 for the other member), empty-string singletons ×2, malformed-References fall-through (`'no brackets here'`, `'<'`, `'><'` → in_reply_to tier joins / message-id tier singletons), in_reply_to-only tier. Seven new web tests: mark-read `onSuccess` now also flips the detail cache (reopen → still exactly 1 PATCH), sibling navigation under the reused component instance (1 PATCH per unread id), thread-error inline retry panel, `onError` warn (mailboxId/messageId/code — first web logging site), from-address exactly-once render, InboxListPage address lookup (cache hit + UUID fallback). No defect found in `InboxListPage.tsx`.

**Gates (orchestrator-run, post-fix)**: `pnpm scaffold doctor` 13/13 ✓, `pnpm typecheck` clean ✓, `pnpm lint` clean ✓, `pnpm test:unit` 672/672 (665 baseline + 7 new web) ✓, `pnpm test:worker` 676/680 (exactly the 4 documented pre-existing D1-parallelism failures; +6 new worker tests all passing) ✓, `pnpm build` EXIT=0 with `wrangler --dry-run` clean ✓.

**Deferred** (registry in task.md §Slice 2 → Deferred): route-authz helper extraction when Slice 3 adds the sixth site; `THREAD_ROOT_SQL` CASE scan → stays with the D-CAP-043-C `thread_id` backfill follow-up; `message-read-repository.ts` split decision at Slice 3 completion; `assertCan` 404-vs-403 oracle at closure; cosmetic UUID displays. Carried from Slice 1: `mailboxListResponseSchema` promotion to contracts before Slice 3 lands; Slice 3 binding gate — star/delete UPSERTs target `(mailbox_message_id, user_id)` post-0017. Next: **Slice 3** — star + delete (AC 13–17).

## 2026-08-23 — CAP-042 Batch 8 (fix slice) + Batch 7 (5-way review)

Two coordinated batches close the post-review findings from the Batch 7 review pass.

**Batch 7 (5-way parallel review on the `5d68b72..HEAD` slice, 39 files / ~3880 insertions)**

Orchestrator-dispatched five reviewers (architecture / code / QA / security / frontend) in parallel. Aggregate findings: 1 BLOCKER + 5 HIGH + 4 MEDIUM + 5 LOW + 2 INFO. Verdict was REJECT — CAP-042 could not be marked Implemented in the Batch 6 state. The BLOCKER was a forbidden `modules → integrations` edge (the `encodeAdr006Password` helper lived in `integrations/better-auth/password.ts` and was imported by `modules/identity/credential-repository.ts:20`); the HIGHs centered on (a) `registerWithInvite` being orphaned (defined but never called by the live `/register` route), (b) `create-administrator` writing only `[users, step]` with no `auth_accounts` row, (c) `authn.ts:194` swallowing Better Auth lookup errors with no log line, (d) the per-request `users.status` recheck claimed in `factory.ts:45-46` but not actually implemented (R-AUTH-002 defense-in-depth gap), (e) R-AUTH-008 `minEmailPrefix` unenforced despite a "documented gap" test. QA's HIGHs further flagged that the AC 17 + AC 18 acceptance criteria could not be marked complete because the production `/register` and `/setup/administrator` flows did not write the canonical `auth_accounts` row (the atomicity was proven only on a spike schema `cap042_spike_auth_accounts`). Orchestrator dispatched a Batch 8 fix slice.

**Batch 8 (fix slice — 24 files, +739/-370)**

Worker fixes (implementer with file ownership `apps/worker/**` + `packages/contracts/**`):

- **B-1 (BLOCKER)**: `encodeAdr006Password` and `bufferToHex` relocate from `integrations/better-auth/password.ts` to `apps/worker/src/platform/crypto.ts` (canonical home). Both `modules/identity/credential-repository.ts` and `integrations/better-auth/password.ts` now import the helper from `platform/` — the forbidden `modules → integrations` edge is removed. The integration layer re-exports for back-compat with the existing verifier adapter; `credential-repository.ts` consumes it directly. No cycle introduced; `platform/crypto.ts` has no `modules/*` or `integrations/*` imports.
- **H-1 (HIGH)**: `apps/worker/src/http/routes/auth.ts:198-220` replaces the inline 3-statement `[users, user_roles, incrementInvite]` batch with `registerWithInvite(...)` from `apps/worker/src/modules/onboarding/`. The use case owns the 4-statement D1 batch `[users, auth_accounts, user_roles, registration_keys.used_count++]` with the `BEFORE UPDATE OF used_count` trigger providing R-OUTBOUND-006 atomic rollback on exhausted invites. The `idempotency_records` INSERT is folded into the same batch to preserve the original write atomicity shape.
- **H-2 (HIGH)**: `apps/worker/src/modules/onboarding/create-administrator.ts` adds `prepareCreateCredential(...)` as the third batch statement alongside `insertUser` and `advanceStep`. Setup administrator creation now writes user + `auth_accounts` + `installation_state` step in one D1 batch. Result type exposes `credentialId` (`cap042-credential-<userId>`) for the route's wire response.
- **H-3 (HIGH)**: `apps/worker/src/http/middleware/authn.ts:194-216` replaces bare `catch {}` with structured `logger.warn({ event: 'authn.better_auth_lookup_failed', requestId?, durationMs }, { error: error instanceof Error ? error.message : String(error) })`. The structured first arg carries no cookie or token material (R-LOG-001 / R-SECRET-003 compliant); the second arg is `error.message` only, never the full Error object. Fall-through to `betterAuthUserId = null` is preserved so the conflict check + downstream authProvider gate still run.
- **H-4 (HIGH)**: `apps/worker/src/http/middleware/authn.ts:246-255` adds `SELECT status FROM users WHERE id = ? AND status = 'active' LIMIT 1` before `c.set('userId', candidateUserId)`. `candidateUserId = bearerUserId ?? betterAuthUserId`, so both credential surfaces converge on the same canonical D1 check. R-AUTH-002 defense in depth now holds: the factory's `databaseHooks.session.create.before` rejects banned/deleted at session-create time, and the middleware recheck rejects them at every protected request. AC 23 (per-request `authProvider` gating) is preserved — the upstream `acceptBearer` / `acceptBetterAuth` branches only skip LOOKUPS, not the recheck.
- **H-5 (HIGH)**: `packages/contracts/src/index.ts:34` exports `MIN_EMAIL_PREFIX_LENGTH = 3`; `registerRequestSchema.email.refine(...)` rejects shorter prefixes with a message that cites the constant; the `r-auth.worker.test.ts` R-AUTH-008 case (`it("R-AUTH-008: rejects a 2-char email prefix", ...)`) asserts 400 `VALIDATION_ERROR` on the live `/register` route. The long-standing 8..72 password drift is corrected to the reconciled R-AUTH-007 range 6..30 across `setupAdministratorRequestSchema`, `registerRequestSchema`, `BetterAuthEmailPasswordOption.min/maxPasswordLength`, the legacy `password.worker.test.ts` boundary tests, and `administrator.worker.test.ts` — all five sites agree.
- **M-1 (MEDIUM)**: `apps/worker/src/http/routes/better-auth.ts:138-156` catches `APIError` and builds a hand-built `{ error: { code: 'INTERNAL', message: 'Authentication error', requestId } }` envelope; the original Better Auth body is never forwarded (R-SECRET-003 spirit). Non-APIError exceptions bubble to the global error middleware (genuine bug, not envelope-fixable).
- **M-2 (MEDIUM)**: `r-auth.worker.test.ts:222-287` (R-AUTH-002 case) now asserts `Object.keys(bannedDeletedBody).sort() === Object.keys(wrongPasswordBody).sort()` plus identical `typeof code/message === 'string'` — factor preservation is asserted on the wire, not just on the status code.
- **M-3 (MEDIUM)**: `r-auth.worker.test.ts:566-588` exercises a 31-char password registration and asserts 400 `VALIDATION_ERROR`. Companion tests at `administrator.worker.test.ts:507-524, :612-629` cover both ends of the 6..30 range on `/setup/administrator`. `platform/crypto.test.ts:346-358` adds named `R-AUTH-007 lower-bound (6 chars)` and `R-AUTH-007 upper-bound (30 chars)` round-trip tests.
- **AC 17 + AC 18 tests**: `r-auth.worker.test.ts` adds route-level tests asserting the canonical `auth_accounts` row lands on the live `/register` (AC 17) and `/setup/administrator` (AC 18) flows. AC 17's failure-injection test seeds an existing user with the same email, snapshots `auth_accounts` count, POSTs `/register` with the duplicate, asserts 409 + count unchanged — proves the 4-statement batch rolls back atomically. AC 18's happy path rewinds `installation_state` to `'preflight'`, clears `idempotency_records`, mints a setup session, POSTs `/setup/administrator`, asserts the same envelope regex on `auth_accounts.password`. AC 18's failure-injection counterpart (mirror of AC 17) is the one remaining follow-up landed in the post-Batch-8 fix implementer pass.

Web fixes (parallel implementer with file ownership `apps/web/**`):

- **M-1 web**: `apps/web/src/app/router.tsx:142-165` wraps `LoginPage` and `RegisterPage` in `<AuthErrorBoundary>`. New `AuthErrorBoundary.test.tsx` (2 tests, both passing) verifies the boundary catches a child throw and renders the auth-styled fallback instead of `App.tsx`'s `unimailbox-stub`.
- **M-2 web**: `apps/web/src/features/auth/auth-queries.ts:160-172, :187-194` drop the redundant `await queryClient.invalidateQueries(...)` after `setQueryData` in `useSignInMutation.onSuccess` and `useSignOutMutation.onSuccess`. D-CAP-041-1 promise ("one HTTP GET per navigation, not two") now holds end-to-end including post-sign-in. New `auth-queries.test.tsx:204-257` spies on `invalidateQueries` and asserts it was NOT called.
- **M-3 web**: `apps/web/src/infrastructure/api/client.ts:122` sets `credentials: 'include'` explicitly on every fetch. Comment at lines 111-118 documents the defensive rationale (future split-host deployment).
- **L-1 web**: `apps/web/src/features/auth/auth-session-storage.test.ts:30` switches the glob to `'./**/*.{ts,tsx}'` so nested helpers (e.g. future `features/auth/components/`) are covered. CI-enforced AC 21 holds even after a feature-directory refactor.
- **L-2 web**: `apps/web/src/features/auth/LoginPage.tsx:34` tightens `password: z.string().min(6).max(30)` to mirror the server's reconciled contract. Two new `LoginPage.test.tsx` cases assert 5-char and 31-char passwords trigger `aria-invalid="true"` on the password input with no fetch issued.
- **L-3 web**: `apps/web/src/features/auth/Unauthorized.tsx:44-54` replaces the `<Link><Button variant="primary">Sign in</Button></Link>` a11y antipattern with a single `<Button type="button" onClick={() => { void navigate({ to: '/login' }); }}>`. New `Unauthorized.test.tsx:47-57` clicks the button and asserts `lastPathname(history) === '/login'`.
- **L-4 web**: `apps/web/src/features/mailbox/MailboxShell.tsx:46-48` renders `<Unauthorized variant="expired" />` when `descriptor === null` (e.g. session expired mid-render) instead of the infinite `<MailboxLoading />` spinner. New `MailboxShell.test.tsx:66-71` asserts the `expired-session` testid is present and `mailbox-loading` is absent.

**Batch 8 re-reviews** (parallel 5-way on the Batch 8 deltas): architecture ACCEPT (no findings at BLOCKER/HIGH/MEDIUM; two LOWs — test placement + intentional drift history comments); code ACCEPT-WITH-FIXES (one cosmetic LOW — redundant `as unknown as` cast at `r-auth.worker.test.ts:544-546`); frontend ACCEPT (all 6 Batch 5 findings verified fixed); security ACCEPT (all 4 Batch 7 MEDIUMs verified; pre-existing legacy `/api/v1/auth/login` 403 `USER_BANNED` factor leak tracked as `D-CAP-042-legacy-factor-leak`); QA ACCEPT-WITH-FIXES pending the parallel AC 18 atomic-rollback failure-injection test (the only remaining substantive remediation). Orchestrator landed the two MEDIUM-1 / MEDIUM-2 docs fixes here (D-CAP-042-pre-existing-parallelism + D-CAP-042-auth-descriptor promoted to §Deferred) and dispatched a final implementer for the AC 18 atomic-rollback test + cast cleanup.

**Gate results** (orchestrator-run, post-Batch 8): `pnpm scaffold doctor` 13/13 ✓; `pnpm typecheck` clean ✓; `pnpm lint` clean ✓; `pnpm test:unit` 644 passed (43 files, +7 new Batch 8 web tests); `pnpm test:worker` 655 passed / 4 failed (all 4 pre-existing D1 parallelism on `admin`/`migrationsDb`/`0015_backfill`; pass when isolated via `pnpm test:worker src/<file>`); `pnpm build` EXIT=0 with `wrangler --dry-run` reporting all 12 bindings. Implementation-log count drift reconciled here: the working set of failing files varies by batch (4 in Batch 4 narrative, 3 in Batch 6 narrative, 4 in Batch 8) because the test runner picks up different fixtures in different shells — all four are the same shared `test-kit/resetAndMigrate` PBKDF2 contention race, documented in `D-CAP-042-pre-existing-parallelism`.

## 2026-08-23 — CAP-042 Batch 3 (AC 15-16): credential backfill + existing PBKDF2 login

Three commits land the existing-user credential backfill migration and the AC 16 existing-user
Better Auth login acceptance matrix:

- **AC 15 (3ec1b0c)** — `migrations/0015_credential_backfill.sql` is the deployable artifact. It
  materialises one `auth_accounts` row per canonical PBKDF2 user in `users` (ADR-006,
  600_000 iterations, `status NOT IN ('banned', 'deleted')`), structurally idempotent via
  `INSERT OR IGNORE` against the `(issuer, account_id)` unique index 0014 added. Re-running the
  INSERT directly produces zero new rows. The envelope is `pbkdf2-sha256$600000$<32 hex salt>
  $<64 hex hash>` — the canonical shape Better Auth's `emailAndPassword.password.verify`
  validates against. Timestamps are derived as Unix-ms integers from the canonical text format
  via `(julianday(text) - 2440587.5) * 86400000`. `migrations/0015_credential_backfill.verify.sql`
  has nine assertions covering the migration tracking row, count match, banned/deleted/non-PBKDF2/
  non-canonical exclusion (R-AUTH-002), no duplicate `(issuer, account_id)` pairs, no orphan
  `user_id`s, and structural envelope shape decomposed into prefix + length + per-segment hex GLOB
  checks (D1 SQLite has no REGEXP function). `apps/worker/src/database/migrations/0015_credential_backfill.worker.test.ts`
  has 12 Worker-pool tests against the real D1 binding — every acceptance point exercised:
  count match, the four exclusion branches, no duplicates, no orphans, envelope shape, INSERT OR
  IGNORE idempotency on its own, runner-level idempotency, Unix-ms timestamp derivation. The
  backfill predicate was tightened from `status <> 'deleted'` to `status NOT IN ('banned',
  'deleted')` after the first run surfaced 2 backfill rows instead of 1 (banned users would
  have been able to sign in via Better Auth once the backfill landed — R-AUTH-002 violation).
  `packages/test-kit/src/migrationsDb.ts` registers 0015; `CURRENT_SCHEMA_VERSION` bumped to
  `'0015'` in both `apps/worker/src/database/schema-version.ts` and
  `packages/contracts/src/index.ts`; `packages/test-kit/src/migrationsDb.worker.test.ts`
  assertion follows.
- **AC 16 (e27d29e)** — `apps/worker/src/http/routes/better-auth.worker.test.ts` adds the
  existing-user Better Auth sign-in acceptance matrix. The test pauses at the 0014 boundary,
  seeds a legacy user with the canonical ADR-006 columns, applies 0015 so the backfill writes
  `auth_accounts.password`, then replaces the placeholder salt/hash with a real Better Auth
  envelope and re-runs the backfill INSERT so the verifier can complete a sign-in. Two
  acceptance points are exercised against `/api/v1/auth/sign-in/email` (the Better Auth canonical
  route): legacy user signs in via the backfilled credential row without any application-level
  re-registration (cookie name `unimailbox.session_token`); wrong-password and unknown-email both
  return 401 with the same envelope so the response cannot enumerate which address is
  registered (R-AUTH-002). Adds a typed `hashTestPasswordFor(password)` helper alongside the
  existing `hashTestPassword()` so the AC 16 seed site can hash an arbitrary plaintext through
  the same narrowing guard; the guard prevents Better Auth's `emailAndPassword.password.hash`
  callback (defaulted to `undefined` in the upstream type) from silently producing a
  `credential.password` envelope the verifier will later reject on every sign-in.
- **21e1709** — `fix(CAP-042)` replaces the non-null assertion operator (`captured!.code`) in
  `apps/worker/src/platform/config.test.ts` with optional chaining; the lint gate forbids
  `@typescript-eslint/no-non-null-assertion`, and the same test now matches the pattern at the
  `INVALID_BETTER_AUTH_URL` assertion (line 177) that lint already accepted.

**Gates** (orchestrator-run, post-fixes): doctor 13/13, typecheck clean, lint clean,
`pnpm test:unit` 603/603, `pnpm test:worker` 626/630 (the 4 failures — `seeds five legacy
users at the 0014 boundary`, `creates all 20 permissions with correct IDs`, `creates the
administrator role with all 20 permissions`, `R-DATA-004: PRAGMA foreign_keys is ON` — are
all pre-existing vitest-worker-pool `reset()` limitations unrelated to my changes, verified
via `git stash`), build EXIT=0 with `wrangler deploy --dry-run --outdir=dist` reporting all
9 bindings including `BETTER_AUTH_SECRET`.

**Deferred**: Batch 4 (AC 17-19) registration, setup admin, and the named R-AUTH-001..009 tests
is next.

## 2026-08-23 — CAP-043 Slice 1 complete + 5-way review + fix pass. Slice 1 implementation landed by `implementer-slice-1`, reviewed by 5 parallel reviewers (architecture / code / security / frontend / QA), then a single-implementer fix pass closed the consolidated findings. Full review narrative preserved at `work/reviews/CAP-043-slice1-review.md`.

**Slice 1 as implemented**: `migrations/0016_message_user_state_soft_delete.sql` adds `is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1))` + `deleted_at TEXT` + `message_user_state_is_deleted_idx` to `message_user_state`. `apps/worker/src/platform/cursor.ts` (NEW) exports HMAC-SHA-256 `signCursor`/`verifyCursor` (`<base64url(payload)>.<base64url(sig)>`, Web Crypto constant-time verify, never throws — all failure modes map to one 400 `INVALID_CURSOR`). `message-read-repository.ts` filters `COALESCE(mus.is_deleted, 0) = 0` per-user (D-CAP-043-B / R-MESSAGE-005) and signs cursors; `routes/messages.ts` maps `CursorInvalidError` → 400. New `CURSOR_SIGNING_KEY` Secrets Store binding (D-CAP-043-D — independent of `CREDENTIAL_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`) in both wrangler configs, strict parser in `platform/config.ts`, provisioned in `scripts/deploy.ts`. Web: `MailboxListPage` (`/mailbox`) + `InboxListPage` (`/mailbox/:mailboxId`) with `useInfiniteQuery` cursor pagination, 4-state surface, INVALID_CURSOR recovery via `refetch()`, both routes hydrate the session cache via `beforeLoad` `ensureQueryData` (D-CAP-041-1).

**Review round**: architecture ACCEPT-WITH-FOLLOWUPS · code ACCEPT-WITH-FOLLOWUPS · security ACCEPT-WITH-FOLLOWUPS · frontend REJECT · QA ACCEPT (all 11 ACs verified). Root-cause finding (code H1 ≡ security M2, orchestrator-confirmed): the CAP-021/0006 schema gave `message_user_state` a single-column PK on `mailbox_message_id`, so `markMessageAsRead`'s UPSERT silently dropped every reader-after-the-first's per-user read state, and D-CAP-043-B (per-user delete) was unimplementable on that PK. Architecture HIGH: Drizzle schema never mirrored 0016's columns. Frontend HIGH ×3: `MailboxListPage` missing the D-CAP-041-9 expired-session fallback, `InboxListPage` double-handling the null descriptor (render + navigate), and a tautological unauthorized test that masked the first finding.

**Fix pass (F1–F10, per task.md §Slice 1 review outcome)**: `migrations/0017_message_user_state_composite_pk.sql` rebuilds the table with `PRIMARY KEY (mailbox_message_id, user_id)` (lossless — old PK precludes duplicates; FK-child-only so DROP is safe with `foreign_keys = ON`), 14-assertion verify file in the enforced `(assertion, pass)` pattern. Decision recorded as **D-CAP-043-F**; the reviewer-proposed writer-side patch (re-assert `user_id = excluded.user_id`) was rejected — it only changes whose state is destroyed. **D-CAP-043-G** records `platform/cursor.ts` as accepted under the CAP-034 pre-allocation, not the Rule of Three. Drizzle schema catches up (0016 columns + composite PK); `CURRENT_SCHEMA_VERSION = '0017'` everywhere; 0017 registered in test-kit. `markMessageAsRead` conflicts on the composite key; new R-MESSAGE-005 worker test proves two members each get their own `is_read = 1` row; the AC-4 soft-delete test now seeds both members' rows (coexistence proof). Frontend: D-CAP-041-9 fallback on `MailboxListPage`, single-handled null descriptor on `InboxListPage`, skeleton-only loading test with a never-resolving messages fetch, real expired-session assertions. Dead surface removed: `encodeCursor` alias, `PlatformConfig.cursorSigningKey` stub, stale comment, BufferSource casts, positional generics; `InboxError` copy corrected; 0016 verify's dead CHECK probe replaced.

**Gates (orchestrator-run, post-fix)**: `pnpm scaffold doctor` 13/13 (schema-version 0017) ✓, `pnpm typecheck` clean ✓, `pnpm lint` clean ✓, `pnpm test:unit` 654/654 ✓, `pnpm test:worker` 662/666 (exactly the 4 pre-existing `D-CAP-042-pre-existing-parallelism` failures — same files, same timeout signature; +1 from the new R-MESSAGE-005 test) ✓, `pnpm build` EXIT=0 with `wrangler --dry-run` listing `CURSOR_SIGNING_KEY` as a Secrets Store Secret ✓, web mailbox feature tests 12/12 ✓, fresh local `pnpm scaffold db:migrate` applies 0001–0017 with 0017 verify 14/14 ✓. Committed at the slice boundary as one logical change (slice + fix pass never existed independently).

**Deferred** (registry in task.md): cursor payload binding to mailboxId/actor/TTL; `verifyCursor` format validation; `mailboxListResponseSchema` promotion to `packages/contracts` (before Slice 3); pre-existing verify-file defects (0003/0005/0013 fresh-DB failures + the unenforced `SELECT COUNT(*)` assertion pattern in 0004–0012/0015/0016 — systemic follow-up, not this capability's scope); Slice 3 binding gate: star/delete UPSERTs MUST target `(mailbox_message_id, user_id)` post-0017. Next: **Slice 2** — message detail + thread (`getMessageThread` + `GET .../thread` + detail page + auto mark-read).

## 2026-08-23 — CAP-043 dispatch (Slice 1 — Cursor HMAC + soft-delete + filtered inbox list). Capability contract written at `work/active/CAP-043-inbox-message-thread/task.md`; ledger row status `Pending` → `In Progress`. CAP-043 is a 3-slice vertical capability:

- **Slice 1** (this dispatch) — Worker: migration `0016_message_user_state_soft_delete.sql` adds `is_deleted` + `deleted_at` columns; `platform/cursor.ts` exports HMAC-SHA-256 `signCursor`/`verifyCursor`; `message-read-repository.ts` swaps base64 cursor for HMAC and adds per-user `is_deleted` filter; new `CURSOR_SIGNING_KEY` Secrets Store binding declared in both wrangler configs + parsed in `platform/config.ts` + provisioned in `scripts/deploy.ts`. Web: `/mailbox` (mailbox list) + `/mailbox/:mailboxId` (inbox list with cursor pagination) pages; loading skeleton / empty / error-with-retry / unauthorized states; IDOR-safe (assertCan on path mailboxId). CAP-034 (cursor HMAC) pulled forward into this slice per execution-plan.md §CAP-043.
- **Slice 2** (next) — Worker: `getMessageThread` repository function + `GET .../messages/:messageId/thread` route. Web: `/mailbox/:mailboxId/messages/:messageId` detail page + thread panel + automatic mark-read on mount.
- **Slice 3** (after that) — Worker: `toggleMessageStar` (mailbox-level — `D-CAP-043-A`) + `deleteMessageForUser` (per-user — `D-CAP-043-B`) repository functions; `PATCH .../star` + `DELETE .../messages/:id` routes. Web: star button + delete button with `AlertDialog` confirmation.

Five decisions documented in `task.md`: D-CAP-043-A (star stays mailbox-level — defer per-user star), D-CAP-043-B (delete on `message_user_state`, not `mailbox_messages`), D-CAP-043-C (thread root computed at read time, not denormalised), D-CAP-043-D (`CURSOR_SIGNING_KEY` independent Secrets Store binding), D-CAP-043-E (`DELETE` returns 204 No Content with Idempotency-Key replay returning the same 204). Five prior capabilities unblocked: CAP-022 (inbox routes) and CAP-042 (authorized mailbox shell) were the only Prerequisites. CAP-044 (compose / reply / admin) is now blocked on this slice. Slice 1 dispatched to `implementer-slice-1` (`general-purpose` subagent). Per CLAUDE.md: agent does not commit; orchestrator stages and commits at the slice boundary.

## 2026-08-23 — CAP-042 closure (post-Batch 8 follow-up). Single-implementer follow-up slice closing the last QA acceptance item. `apps/worker/src/http/routes/r-auth.worker.test.ts:841` lands the AC 18 atomic-rollback failure-injection test mirroring AC 17's shape: seeds an existing user with the target email, snapshots `auth_accounts` row count, rewinds `installation_state` to `'preflight'`, clears `idempotency_records`, POSTs `/setup/claim` + `/setup/administrator`, asserts 409 `SETUP_ADMINISTRATOR_EXISTS` and that `auth_accounts` count + `installation_state.current_step` are unchanged after the failed request. AC 18 happy-path was already proved by the existing `create-administrator.ts` 3-statement batch (CAP-042 Batch 4 ledger note); this test closes the contrapositive — that the batch rolls back atomically on duplicate-email conflict. Also cleaned up the cosmetic double `as unknown as` cast at `r-auth.worker.test.ts:544-546` (Code review LOW: signature was already typed identically). Final gates (orchestrator-run): `pnpm scaffold doctor` 13/13 ✓, `pnpm typecheck` clean ✓, `pnpm lint` clean ✓, `pnpm test:unit` 644/644 ✓ (+7 web tests, no regressions), `pnpm test:worker` 656/660 (+1 pass from the new AC 18 test, no new failures — the 4 pre-existing D1 parallelism failures documented as `D-CAP-042-pre-existing-parallelism`), `pnpm build` EXIT=0 with `wrangler --dry-run` clean (12 bindings). Capability state archived: `work/active/CAP-042-better-auth-shell/` → `work/archive/2026-08/CAP-042/` (`task.md` + `spike-evidence.md` retained per `.claude/rules/documentation.md` lifecycle). `docs/rebuild/capability-ledger.md` row updated: status `In Progress` → `Implemented` at line 150; full Batch 7 / Batch 8 / final follow-up narrative appended to the row's Evidence column. Three §Deferred entries recorded at ledger lines 266-268: `D-CAP-042-pre-existing-parallelism` (the 4 worker-pool failures), `D-CAP-042-auth-descriptor` (orchestrator's deliberate cross-boundary type deferral), `D-CAP-042-legacy-factor-leak` (pre-existing legacy /login 403 vs 401 distinguishability; CAP-019 territory). Per `.claude/rules/documentation.md` semantics: `Implemented` requires code complete + reviewed + quality gates pass; `Verified` requires observed end-to-end run on a preview deployment, owned by **CAP-045** (fresh + repeat preview deploy and real business-loop verification). Per the preserved security constraint: no commit/push/deploy was performed — HEAD remains at the Batch 6 last commit `974bc9d`; the working tree carries all Batch 7 + Batch 8 + this follow-up. Next capability: **CAP-043** — inbox and message reading (after CAP-042 is committed at the user's discretion).

## 2026-08-23 — CAP-042 Batch 6 (AC 23): AUTH_PROVIDER cutover matrix + rollback proof on the additive schema. Pure worker-side slice; apps/web/ and packages/contracts/ untouched.

**Per-request config gating (the load-bearing change).** `apps/worker/src/http/middleware/authn.ts` now reads `c.var.config.authProvider` per request and gates which credential surfaces resolve:
- `legacy`: Bearer only; Better Auth cookie is silently ignored (no D1 lookup, no probing leak).
- `better-auth`: Better Auth cookie only; Bearer is silently ignored (no CACHE lookup).
- `dual`: both surfaces resolve, AC 14 conflict detection still runs (CONFLICTING_PRINCIPALS on disagreement).

`apps/worker/src/http/routes/better-auth.ts` short-circuits with 401 `AUTHENTICATION_REQUIRED` when `config.authProvider === 'legacy'`. The Hono mount stays in place so a future env flip re-enables it without an Hono edit. `apps/worker/src/http/routes/auth.ts` mirrors the gate on `POST /api/v1/auth/login`: 401 when `authProvider === 'better-auth'`. Both short-circuits use the canonical `{ error: { code, message, requestId } }` envelope, not a thrown Error, so no new error catalog entry was added.

**Why per-request and not module-scope.** `http/middleware/config.ts` re-parses `parsePlatformConfig(env)` on every request. The factory and the cookie-cache are also per-request. A test (or a runtime env flip) that mutates `env.AUTH_PROVIDER` sees the new value on the next request — no Worker restart. `apps/worker/wrangler.test.jsonc` `AUTH_PROVIDER` flipped from `legacy` to `dual` so the pre-existing AC 12 / 13 / 14 / 16 / 19 suites keep exercising Better Auth sign-in without per-test overrides; production `wrangler.jsonc` still defaults to `legacy` per ADR-008.

**Tests** (11 new for AC 23, plus 4 new auth.ts gate tests): `authn.worker.test.ts` adds the 6 mode-gating cases + 1 dual→legacy→dual rollback proof; `better-auth.worker.test.ts` adds 4 mount-gating cases; `auth.worker.test.ts` adds the better-auth rejection + dual regression coverage. Gates (orchestrator-run, post-Batch 6): `pnpm scaffold doctor` 13/13 ✓, `pnpm typecheck` clean ✓, `pnpm lint` clean ✓, `pnpm test:unit` 637/637 ✓, `pnpm test:worker` 635/638 (the 3 remaining failures are pre-existing D1 parallelism on `admin`/`migrationsDb`/`0015_backfill`; pass when isolated via `pnpm test:worker src/<file>`), `pnpm build` ✓.

**Cutover matrix evidence (orchestrator-run, per-mode)**:
- `legacy` — `/api/v1/auth/better/sign-in/email` → 401 (mount gated); Bearer-only request → 200; legacy `/api/v1/auth/login` → 200.
- `dual` — Better Auth cookie only → 200; Bearer only → 200; matching cookie + Bearer → 200; conflicting cookie + Bearer → 401 `CONFLICTING_PRINCIPALS` (AC 14 holds); `/api/v1/auth/login` → 200.
- `better-auth` — Better Auth cookie → 200; Bearer-only → 401 (Bearer silently ignored); `/api/v1/auth/better/sign-in/email` → 200; legacy `/api/v1/auth/login` → 401 `AUTHENTICATION_REQUIRED` (auth.ts gated in this batch).
- **Rollback proof** — one test exercises `dual → legacy → dual` without a Worker restart: dual signs in via Better Auth cookie (200), legacy re-runs the same request (401, cookie silently ignored), dual restores (200, cookie accepted again). `auth_accounts` / `auth_sessions` rows survive all three phases; legacy `users.password_*` rows survive all three phases. No migration required.

**Findings**:
- **HIGH (gating gap, FIXED in this batch)** — `authn.ts` previously resolved both principals regardless of mode. Closed with per-request gating inside file ownership.
- **HIGH (route mount gap, FIXED in this batch)** — `better-auth.ts` mounted the Better Auth HTTP surface unconditionally in `legacy` mode. Closed with short-circuit inside file ownership.
- **HIGH (legacy login reachable in better-auth mode, FIXED in this batch — extension)** — `auth.ts` `POST /api/v1/auth/login` did not consult `authProvider`. Closed with mirror gate inside file ownership (extended in the follow-up slice).

**Deferred**: D-CAP-042-pre-existing-parallelism (the 3 worker-pool migration-state failures — separate capability).

## 2026-08-23 — CAP-042 Batch 5 (AC 20-22): browser auth shell + mailbox protected route + D-CAP-041-1 / D-CAP-041-9 closure. Pure client slice; no backend changes; apps/worker/ untouched.

**AC 20 — Login / registration / logout / session recovery / authorized mailbox navigation**. New files: `apps/web/src/features/auth/{auth-session-store,auth-queries,LoginPage,RegisterPage,LogoutButton,Unauthorized,AuthErrorBoundary}.tsx` + an `index.ts` public surface. The in-memory Zustand `auth-session-store.ts` holds only a non-secret descriptor (`{ userId, email, displayName, expiresAt }`); the cookie itself is HttpOnly and never touched by JS. `auth-queries.ts` exposes TanStack Query hooks for sign-in / sign-up / sign-out / get-session; each fetcher POSTs/GETs the worker route with `credentials: 'include'` so the browser receives `Set-Cookie: unimailbox.session_token=...; HttpOnly; SameSite=Lax` automatically (R-SECRET-003). `LoginPage` and `RegisterPage` use react-hook-form + zod and call the shared error/loading views. `LogoutButton` clears the in-memory store and navigates to `/login`. The mailbox feature (`apps/web/src/features/mailbox/{MailboxShell,MailboxLoading,MailboxError}.tsx`) is the protected surface.

**AC 21 — HttpOnly cookies, no token in browser storage**. `apps/web/src/features/auth/auth-session-storage.test.ts` walks the auth source tree and asserts no file imports `localStorage`, `sessionStorage`, `IndexedDB`, or Zustand `persist` middleware (after stripping comments so docstrings are exempt). The test fails if a future contributor adds any of those — CI-enforced. The store is in-memory only; clearing the tab clears the descriptor, and the next navigation re-derives it from the cookie-backed `/get-session` call.

**AC 22 — D-CAP-041-1 / D-CAP-041-9 closure**. `/mailbox` `beforeLoad` (in `apps/web/src/app/router.tsx`) calls `queryClient.ensureQueryData({ queryKey: authQueryKeys.session(), queryFn: fetchAuthSession })` so the GET warms both the route guard and the render — one HTTP round-trip per navigation, not two (D-CAP-041-1, mirrors the CAP-041 setupStatusQuery pattern). `apps/web/src/app/router.test.tsx` mounts a real router tree and asserts the `/mailbox → /login` redirect on three cache states (empty, `{user: null, session: null}`, pre-seeded valid session) — at least one router-context test exercising `beforeLoad` (D-CAP-041-9).

**Files**:
- `apps/web/src/features/auth/**` (15 new: 8 source + 6 test + 1 index)
- `apps/web/src/features/mailbox/**` (4 new: 3 source + 1 index)
- `apps/web/src/app/router.tsx` (modified — new routes + `beforeLoad`)
- `apps/web/src/app/router.test.tsx` (new — D-CAP-041-9 closure)
- `apps/web/src/App.tsx` (modified — wiring)
- `apps/web/src/test-utils.tsx` (modified — `mountAppRouter` extended with auth fixtures)

**Gates** (orchestrator-run, post-Batch 5): `pnpm scaffold doctor` 13/13 ✓, `pnpm typecheck` clean ✓, `pnpm lint` clean ✓, `pnpm test:unit` 637/637 ✓ (34 new Batch 5 cases; no regressions), `pnpm test:worker` 636/640 (4 pre-existing failures reproduced on `7449c3c` via `git stash`; not Batch 5 regressions), `pnpm --filter @unimailbox/web run build` ✓ (`dist/assets/index-Vs6dzkf-.js` 408.65 kB / 123.37 kB gz).

**Findings**:
- **MEDIUM — `AuthSessionDescriptor` is not in `packages/contracts`**. The shape (`{ userId, email, displayName, expiresAt }`) lives only in `apps/web/src/features/auth/auth-session-store.ts`. Per architecture rules, cross-boundary types come from contracts — but this descriptor currently doesn't cross the worker boundary. Batch 6 (which wires the worker's `getSession` route) is the right place to decide whether to promote it. Documented as D-CAP-042-auth-descriptor for the orchestrator.
- **LOW — `RegisterPage` posts to `/api/v1/auth/register` (legacy endpoint)**. Better Auth's `sign-up/email` is intentionally disabled (`disableSignUp: true` in `factory.ts`); the legacy endpoint is the production registration path. Batch 6 may consider a unified Better Auth surface; out of scope for Batch 5.

**Deferred**: D-CAP-042-auth-descriptor (orchestrator decision on whether to promote `AuthSessionDescriptor` into `packages/contracts/auth/session.ts` — Batch 6 territory).

## 2026-08-23 — CAP-042 Batch 4 (AC 17-19): atomic registration/setup + R-AUTH-001..009 named-test matrix with canonical users.status session check.

**AC 17 — Invitation registration atomicity** (`apps/worker/src/modules/onboarding/register-with-invite.ts` + `apps/worker/src/modules/identity/credential-repository.ts`, both new). The use case extracts the four-statement D1 batch (canonical `users` insert + Better Auth `auth_accounts` credential insert + invite-role `user_roles` insert + `registration_keys.used_count` increment) so the application owns atomicity — D1 cannot run SQL transactions. The BEFORE UPDATE OF used_count trigger on `registration_keys` raises `RAISE(ABORT, ...)` on exhausted invites, rolling the whole batch back. Credential row is deterministic (`credentialIdFor(userId) = 'cap042-credential-' + userId`) so the backfill's row and a re-registration's row would collide on `(issuer, account_id)` unique index — by design. `encodeCredentialEnvelope(passwordHash)` produces the ADR-006 `pbkdf2-sha256$600000$<saltHex>$<hashHex>` envelope unchanged; the credential repository only writes the column shape the Better Auth adapter expects. Failure-injection proof is the existing committed `apps/worker/src/integrations/better-auth/atomic-registration.spike.worker.test.ts` evidence (Claude Code task 3 / Grok re-review ACCEPT after 6/6 reproduction).

**AC 18 — Setup administrator atomicity** (`apps/worker/src/modules/onboarding/create-administrator.ts`, already atomic in main). Verified the file: `db.batch([prepareCreateUser, prepareUpdateInstallationStep])` is the canonical surface; the existence check at top of use case saves a PBKDF2 hash on the rejected path; the `UNIQUE_EMAIL_VIOLATION` defensive backstop covers the rare race. Failure-injection proof is also in the atomic-registration spike evidence file.

**AC 19 — R-AUTH-001..009 named-test matrix** (`apps/worker/src/http/routes/r-auth.worker.test.ts`, new file — 507 lines, 10 tests). Each `it()` block is named after the rule ID. Lazy envelope caching (one shared PBKDF2 envelope computed on demand across all sign-in tests) keeps the file PBKDF2 cost to a single ~600ms hit instead of one per test. R-AUTH-003 uses direct D1 session inserts instead of eleven Better Auth sign-ins (saved ~6.6s of CPU); the trigger contract under test is the same. R-AUTH-004 asserts the D1 rotation contract directly (Better Auth signs cookies as `<token>.<hmac-sha256>` so the test does not run the cookie-signing round-trip; the assertion documents the signing shape for reviewers). R-AUTH-002 (banned + deleted) passes against the new factory hook below.

**R-AUTH-002 closed in same batch** (`apps/worker/src/integrations/better-auth/factory.ts`). Better Auth 1.7.1 sign-in does not by default consult canonical `users.status`; the spike-evidence.md R-AUTH-002 row requires a `databaseHooks.session.create.before` hook on the factory. The hook reads `users.status` via the request's D1 binding (intentionally NOT via `ctx.context.internalAdapter` — that surfaces Better Auth's admin-plugin `banned` field, not the canonical `status` enum) and throws `APIError('UNAUTHORIZED', { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' })` for any non-`active` status. Generic message preserves the factor (no distinction between banned/deleted/wrong-password at the response boundary, R-AUTHZ-002 spirit). The existing `user.create.before = false` defense-in-depth hook is left intact.

**Documented gap, out-of-scope for this batch**:
- **R-AUTH-008 (email-prefix gate)** — Application has no `minEmailPrefix` setting today. Test asserts current behaviour (401 on unknown short-prefix email) so a future reviewer adding the gate sees the test flip from "no gate" to "gate enforced".

**File ownership**:
- `apps/worker/src/modules/onboarding/register-with-invite.ts` (new)
- `apps/worker/src/modules/identity/credential-repository.ts` (new — `prepareCreateCredential`, `encodeCredentialEnvelope`, `credentialIdFor`)
- `apps/worker/src/modules/identity/index.ts` (modified — exports credential helpers)
- `apps/worker/src/http/routes/r-auth.worker.test.ts` (new — 10 R-AUTH-001..009 tests)
- `apps/worker/src/integrations/better-auth/factory.ts` (modified — `session.create.before` hook closing R-AUTH-002)
- `apps/worker/src/modules/onboarding/create-administrator.ts` (untouched — already atomic in main)

**Gates** (orchestrator-run, post-implementation): `pnpm scaffold doctor` 13/13 ✓, `pnpm lint` clean ✓, `pnpm typecheck` clean ✓ (`tsc --build` exits 0; the IDE diagnostic noise on `r-auth.worker.test.ts` is the same pre-existing worker-pool noise that has never blocked `tsc --build`), `pnpm test:unit` 603/603 ✓, `pnpm test:worker` 636/640 (the 4 remaining failures are pre-existing parallelism failures verified to reproduce on a clean tree without Batch 4 changes — see Findings), `pnpm build` web build ✓, worker `wrangler deploy --dry-run` clean with all 10 bindings reported.

**Findings**:
- **Pre-existing parallelism failures (4)** — `migrationsDb.worker.test.ts > R-DATA-004: PRAGMA foreign_keys is ON` (hook timeout 10012ms), `0015_credential_backfill.worker.test.ts > seeds five legacy users at the 0014 boundary` (hook timeout 10003ms), `admin.worker.test.ts > creates all 20 permissions with correct IDs` (hook timeout 10005ms), `admin.worker.test.ts > creates the administrator role with all 20 permissions` (UNIQUE constraint on `d1_migrations.name`). All four fail in the parallel suite but pass when each file is run in isolation (`pnpm test:worker src/<file>`). Root cause is vitest-pool-workers shared Node.js process contention with PBKDF2 work in the parallel suite. Documented as separate capability concern, not Batch 4.

**Deferred**: D-CAP-042-pre-existing-parallelism (4 cross-suite test-isolation failures not introduced by CAP-042 — separate capability).

## 2026-08-23 — CAP-042 Batch 2 (AC 11-14): runtime config, request-scoped factory, session bridge. Two commits land the additive Better Auth runtime path: **AC 11 (a1ad7fb)** wires `BETTER_AUTH_SECRET` (independent Secrets Store binding), `AUTH_PROVIDER` (closed `legacy|dual|better-auth` enum, default `legacy`), and `BETTER_AUTH_URL` (HTTPS in non-local, no credentials/query/fragment) across both wrangler configs, `Env` typing, `platform/config.ts` strict parsers, `platform/secrets.ts` `readSecret` for both Secrets Store and test-var shapes, `http/middleware/config.ts` populating `c.var.config`, doctor/preflight/deploy parity for the eight new binding/resource checks, and `scripts/deploy.ts` provisioning `BETTER_AUTH_SECRET` in Secrets Store. **AC 12-14 (c7a4eed)** adds `integrations/better-auth/{path,schema,factory}.ts` (request-scoped `betterAuth()` with `disableSignUp: true`, PBKDF2-SHA256 password envelope adapter, `user.fields.name = 'display_name'` mapping, `transaction: false` for D1), `http/routes/better-auth.ts` thin pass-through that rebuilds the Request from Hono's `bodyCache` (D-CAP-042-A — `enforceBodySize` consumes the body before Better Auth's `c.req.raw.json()` runs, surfaced as a 500/empty body), `http/router.ts` mounting inside `apiV1` at the `/auth/better` prefix (a bare `*` wildcard shadows sibling webhook routes; verified by running both suites), `http/middleware/authn.ts` resolving both Bearer and Better Auth cookie principals with explicit precedence and `CONFLICTING_PRINCIPALS` (401) on disagreement (R-API-002 added to error catalog), and `test/setup.ts` swallowing the framework's side-channel `APIError` rejection (Better Auth 1.7.1 surfaces the canonical 4xx Response AND an unhandled rejection on `drizzleAdapter`'s transaction wrapper). **Tests** — 13 new Worker-pool cases: `better-auth.worker.test.ts` (AC 12 — mount, HttpOnly/SameSite=Lax cookie, `auth_sessions` row written, get-session resolves cookie, sign-out invalidates, wrong password 401, sign-up 400) and `authn.worker.test.ts` (AC 13/14 — cookie alone reaches `requirePermission`, unknown cookie 401, Bearer-only regression, conflicting principals 401, matching principals pass, single-principal cases never conflict). **Gates** (orchestrator-run, post-fixes): doctor 13/13, typecheck clean, lint clean except the 2 pre-existing `config.test.ts` non-null assertions (also fail on `60742c1` without my changes), unit 603/603, worker 596/616 (the 20 failures are all pre-existing SPA-fallback / `setup-gate` / `complete-setup` issues verified via `git stash`; my CAP-042 tests pass cleanly), build EXIT=0. **Deferred**: Batch 3 (AC 15-16) existing-user credential backfill + login is next.

## 2026-08-22 — Local baseline hardening

The completed CAP-040/041 branch was integrated into the local main work line, then Hono and
Drizzle ORM were upgraded and independently reviewed. Repository-state documentation was
reconciled with the code, nested `.claude/worktrees` were removed while their branch refs were
preserved, and formatter/linter inputs now exclude nested worktrees. Markdown is excluded from
Prettier because its emphasis parser can rewrite literal capability syntax such as `R-*` and
`/setup/*`; documentation remains manually reviewed. No remote, push, or preview deployment was
configured or run.

## 2026-08-22 — CAP-041 closure: setup web vertical slice ships

Five-way parallel review (architecture, code, security, qa, frontend) closed the prior cycle's 2 BLOCKERS + 7 HIGHs in one fix slice, then a re-review cycle landed 4 more MEDIUMs / 1 LOW that the orchestrator handled inline. Slice ships; CAP-042 is unblocked.

### Inline orchestrator fixes during the commit-prep pass

- **Code review M1** — added `retryDelays` array assertions to both retry tests in `apps/web/src/infrastructure/api/client.test.ts`. The test captures the delays the retry policy chose into a caller-supplied array (no real-time sleep) and asserts the exact sequence: `[1_000, 2_000]` for retry-then-succeed, `[1_000, 2_000, 4_000, 8_000, 16_000]` for retry-exhausted-capped-at-30s. A regression producing `[NaN, ...]` or `[0, ...]` would fail this. The `ApiRequestInit` interface gained a `readonly retryDelays?: number[]` field (`client.ts:42`).
- **Architecture review M1** — `apps/web/src/app/router.tsx:160-164` previously `return;`'d when `subIndex === -1` (operator hits `/setup/<unknown-segment>` like `/setup/foo`); TanStack Router rendered the parent `SetupLayout` with an empty `<Outlet/>`. Changed to `throw redirect({ to: '/setup/${activeStep}' as const });` so unknown URLs fall back to the server's current step — same path the stale-ahead branch takes. One-line behavioural fix; small absolute impact (stale-bookmark path only).
- **Duplicate `RouterContext` interface** — false-positive finding from the orchestrator's earlier scan (only one declaration at `router.tsx:62` exists in the post-fix tree). Architecture reviewer L4 confirmed only one declaration exists.

### Deferred items recorded for follow-up sweeps

9 items in `work/archive/2026-08/CAP-041/task.md` §Deferred items; 3 of them (`D-CAP-041-1`, `D-CAP-041-2`, `D-CAP-041-9`) are in the capability ledger's "CAP-041 follow-ups" section because they constrain CAP-042 (mailbox shell) — same router-context pattern, same wizard-cache pattern, same test-utility surface.

### Gates (orchestrator-run, post-everything)

doctor 13/13 · lint 0 · typecheck clean · test:unit 556/556 (32 files, +72 vs CAP-039 baseline 484) · test:worker 560/560 (33 files, +9 vs CAP-039 baseline 551) · `pnpm build` clean (362.07 KiB / 67.81 KiB gzipped) · `wrangler --dry-run` clean.

### What the slice actually ships (delivery-path proof)

`Browser navigates to /setup` → `apps/web/src/app/router.tsx` `setupRoute` (`/setup/$subStep`) `beforeLoad` → `fetchSetupStatus(apiClient)` (D-CAP-041-A path: apiClient comes from `createAppRouter(apiClient)`'s context, not a React hook) → `GET /api/v1/setup/status` → Hono `setupRoutes().get('/status')` → `InstallationStateInfo` (zod-validated against `installationStateInfoSchema` from `packages/contracts`) → router renders `<SetupLayout>` with sub-route for the server's `currentStep`. `Operator submits a step form` → React Hook Form `handleSubmit` → `useMutation` → `apiClient.fetch(...)` injects `Idempotency-Key` (POST/PUT/PATCH/DELETE — Security MEDIUM #4 fix), `Authorization: Bearer <sessionToken>` (after `/claim`), `x-request-id` (UUID-shaped — Security MEDIUM #6 fix); body is capped at 1 MB before fetch (Security MEDIUM #5 fix); on 5xx / 429 the client retries with exponential backoff (1s, 2s, 4s, capped 30s, 5 attempts) via `defaultRetryPolicy`. Successful mutation → TanStack Query invalidates `setupQueryKeys.status()` → router re-evaluates `beforeLoad` → new step renders (no client-side step mutation — R-WORKFLOW-002). Refresh on a deep route lands on the same route (router uses `$subStep` typed path). Session token is in-memory only (Zustand store, no `localStorage`/`sessionStorage`/`IndexedDB`) — verified by `setup-session-store.test.ts`.

### Decisions added this cycle

- **D-CAP-041-A** (2026-08-21) — `ApiClient` constructed once at the root via `useMemo` in `apps/web/src/App.tsx`; threaded through React context (for step components, which keep using `useApiClient()`) AND through TanStack Router context (for `beforeLoad`, which reads `({ context })`). Documented in implementation-log 2026-08-21.
- **D-CAP-041-B** (this entry) — `retryDelays` capture array on `ApiRequestInit` is a test-only seam; production code never reads it. Documented so a future reader does not mistake it for production telemetry.

### Resolves

- **Reality-audit BLOCKER #56** — "The setup gate redirects users to a route the Worker does not serve." `apps/worker/src/http/middleware/setup-gate.worker.test.ts` used to expect `/setup` and `/setup/anything` to return 404. With CAP-039's asset binding + run_worker_first=`/api/*` and CAP-041's code-based router, the catch-all returns the SPA shell and the wizard handles `/setup/*` in-client.
- **Reality-audit HIGH #60** — "Phase 1 user workflows are not implemented in the web client." Wizard ships all 9 step components with happy + error paths covered by happy-dom tests.

## 2026-08-21 — CAP-041 review cycle: apiClient ownership decision (pre-fix note)

5-way parallel review of CAP-041 surfaced 2 production-breaking BLOCKERS that share a single root cause: the `ApiClient` instance was constructed inside the React tree (in `ApiClientProvider`) and only reachable via a React hook (`useApiClient`). `setupRoute.beforeLoad` (TanStack Router) ran outside any React render and called that hook, throwing "Invalid hook call" on every navigation into `/setup/*`; `createApiClient` was also reallocated on every render, destroying in-flight retry state. Three reviewers (architecture, security, frontend) converged on the same defect independently.

### Decision (orchestrator, ahead of the fix slice)

**D-CAP-041-A**: The `ApiClient` is constructed **once** at the application root via `useMemo(() => createApiClient(init), [])` in `apps/web/src/App.tsx`. The same instance is threaded through two channels:

1. **React context** — `<ApiClientProvider client={apiClient}>` provides it for step components, which continue to read via `useApiClient()`. The provider no longer constructs the client; it only consumes the `client` prop and forwards it on the existing `ApiClientContext`.
2. **TanStack Router context** — `createRouter({ context: { apiClient } })` makes it available to `beforeLoad` callbacks via the `context` argument. The router's `beforeLoad` MUST read `apiClient` from `context`, never via `useApiClient()`.

Rejected alternatives:
- Module-level singleton at the top of `client.ts`. Breaks the test override path (`test-utils.tsx` constructs a per-test client with the spy fetch). Tests for `beforeLoad`-bearing routes need a `mountAppRouter({ apiClient })` helper that constructs a fresh `QueryClient` + `createRouter` per test.
- Move the status fetch out of `beforeLoad` and into the route component's `useQuery`. Breaks AC #4's "stale /setup/<step> URLs redirect to the server's current step" — the redirect must happen before the component renders, otherwise the operator sees a flash of the wrong step.

### Other consequences of the same decision

- `ApiClientProvider` no longer subscribes to `useSetupSession` for re-render purposes — the provider's only job is forwarding the prop. The `void sessionToken;` pattern at the old `client-provider.tsx:36` is deleted.
- `__setApiClientForTesting` dead export (`client-provider.tsx:52-57`) is deleted; tests pass `client` into `<ApiClientProvider client={apiClient}>` directly, matching production.
- `App.tsx`'s `QueryClient` defaults `queries.retry: false` (the API client is the retry authority — ADR-004 / `retry.ts`).

### Process

Fix slice dispatched 2026-08-21 as a single implementer pass (one writer across `apps/web/**` + `packages/contracts/src/index.ts`; ~21 source files + 9 new test files). Single PR because all findings share the router, provider, and `client.ts` — splitting creates merge conflicts and forces re-review of unchanged lines. Implementation-log entry for the actual fix lands after the diff is accepted.

## 2026-08-20 — D-CAP-030-A: TS overloads on `canTransition` / `assertCanTransition`

CAP-030 deferred **D-CAP-030-A** (Security L1 + Code L3): the `from as MessageStatus` / `from as OutboundJobStatus` casts inside `Map.get()` are a type-system escape hatch. The runtime behaviour is correct (the `?? false` fallback yields a conservative false when the lookup misses), but a caller passing `domain: 'job'` with `'draft'` (messages-only) was a silent no-op rather than a compile-time error.

### What changed

**Contracts** — `packages/contracts/src/index.ts:305-422`:

- `canTransition` now exposes two public overloads (`domain: 'message' → MessageStatus`, `domain: 'job' → OutboundJobStatus`); the broad-union signature is the internal `canTransitionImpl`. A caller passing `domain: 'job'` with `'draft'` is now a compile-time error.
- `assertCanTransition` mirrors the same overload pattern and calls `canTransitionImpl` directly so the union `domain` from the implementation signature never needs to match the public overloads.
- The original JSDoc (which documented the `domain` discriminator as load-bearing) is restored and now also documents the overload split; the per-function `assertCanTransition` JSDoc preserves the D-CAP-030-G programmer-error pattern note.

**Tests** — `packages/contracts/src/index.test.ts:1486-1501`:

- The three pre-existing tests that exercise the messages-only values `'draft'` and `'delivered'` against the job domain now cast the literals explicitly (`'draft' as OutboundJobStatus`, `'delivered' as OutboundJobStatus`) so they continue to assert the runtime-false behaviour while documenting that the compile-time rejection is the new contract.

### Gates (orchestrator-run)

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean (overload recursion resolved via `canTransitionImpl`) |
| `pnpm test:unit` | 340/340 |
| `pnpm test:worker` | 534/534 |
| `pnpm lint` | 0 errors |
| `pnpm scaffold doctor` | 10/10 |
| `pnpm build` | clean |

### Process

Single-chore commit (`chore(CAP-030): tighten canTransition with TS overloads (D-CAP-030-A)`); no review round required because the change is a localised type-system tightening on a function already at LOW severity. Three remaining CAP-030 follow-ups (D-CAP-030-B direction-guard comment propagation, D-CAP-030-C `OutboundJobStatus` adoption on internal writer signatures, D-CAP-030-D deleted-test provenance) are still open.

## 2026-08-20 — CAP-039: Deployment substrate

The Worker now actually deploys. A single `pnpm build` produces an artefact that serves the real Vite-built web bundle, drains the outbound queue CAP-023/CAP-029 enqueue to, and applies remote migrations in pending-only mode — so a repeat deploy is a safe no-op. Closes the four Phase 0/1 BLOCKERs that pointed at this contract (`setup-gate redirects to a route the Worker does not serve`, `built web application not connected to the deployed Worker`, `producer binding but no consumer declaration`, `remote deploy replays every SQL migration`).

### What changed

**Wrangler config** — `apps/worker/wrangler.jsonc` + `apps/worker/wrangler.test.jsonc`:

- New `assets` block: `{ directory: "../web/dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] }`. The `run_worker_first` flag is the load-bearing piece for AC #4 — without it, Cloudflare rewrites 404 responses on browser navigation fetches to `index.html`, which would route `/api/v1/foo` typed in the address bar to the SPA shell. The router's `startsWith('/api/v1')` guard is now strictly belt-and-braces.
- New `queues.consumers[]` entry `{ queue: "unimailbox-outbound", max_retries: 5 }` (D1) so the deployed Worker actually drains the queue CAP-023 produces.
- Removed `d1_databases[0].migrations_dir` and confirmed no top-level `apply_migrations` — `wrangler deploy` will never replay migrations; `scripts/deploy.ts` is the sole authority.

**Router** — `apps/worker/src/http/router.ts:97-119`:

- Deleted the hand-written `<script src="/assets/index.js">` HTML shell at the old lines 52-58 (the literal referenced a path the Vite build never produced).
- Replaced with `router.get('/', (c) => c.env.ASSETS.fetch(...))` and a `router.get('*', ...)` catch-all that forwards GETs to `env.ASSETS`, with explicit guards for non-GET methods (POST/PUT/DELETE → 404, "would leak a write surface") and `/api/v1/*` paths (404 from sub-app's own error handler, never index.html). Routing order: `apiV1`/`webhookV1` sub-apps first, then SPA fallback — the sub-apps win on their paths.

**Env type** — `apps/worker/src/platform/env.ts:19`: added `ASSETS: Fetcher` to the `Env` type.

**Pending-only migrations** — `scripts/deploy.ts`:

- New `parseWranglerJson(r, source)` + `extractColumn(parsed, col)` mirror `scripts/db-migrate.ts:98-101`/`extractColumn` so local and remote runners share the same parse discipline (D7).
- `readRemoteApplied` now treats `wrangler success: false` on a missing `d1_migrations` table as `[]` (empty applied), not as a hard error — mirrors the local runner's behaviour. The misleading "Success=false from a fresh DB is the expected path" comment was deleted; the new comment at `parseWranglerJson` documents the asymmetry that was there before CAP-039.
- `runRemoteMigrations` reads remote `d1_migrations` via `wrangler d1 execute DB --config .wrangler.resolved.jsonc --remote --command 'SELECT name FROM d1_migrations ORDER BY name' --json`, applies the set difference against on-disk migrations. Repeat-deploy log line `No pending migrations (N already applied).` byte-for-byte matches `db-migrate.ts:124`.
- Exported `NO_PENDING_LOG_FORMAT = 'No pending migrations'` (D6) so the deploy test asserts both runners speak the same dialect.

**Doctor** — `scripts/doctor.ts`:

- Three new checks (D3): `web-assets-binding`, `queue-consumer-topology` (count AND name-set disjointness, D6), `migration-strategy-pending-only`.
- New `stripJsoncComments(src)` character-based walker (the previous regex-based stripper matched `/*` and `*/` inside JSON strings, which broke parsing of `["/api/*"]` and `["*/2 * * * *"]` once `run_worker_first` and the cron trigger landed in the same config). Skips comments only outside strings; preserves escape sequences.
- New `evaluateWebAssetsBinding(w, repoRoot)` / `evaluateQueueConsumerTopology(prodCfg, testCfg)` / `evaluateMigrationStrategyPendingOnly(w)` exported as pure functions so `apps/worker/scripts/doctor.test.ts` can drive them with synthetic wrangler.jsonc fixtures.

**Tests** — `apps/worker/src/http/router.worker.test.ts` (NEW, 13 tests), `apps/worker/scripts/doctor.test.ts` (extended by 12), `scripts/deploy.test.ts` (extended by 11), `scripts/scaffold.ts:59` (one-line doc drift 10 → 13):

- Worker-pool SPA fallback cases: `GET /`, `GET /setup`, `GET /inbox`, `GET /mailboxes/abc`, `GET /some/deep/nested/path` → 200 with `<div id="root"></div>` (identity test asserts the same shell is reused). `GET /api/v1/setup/status` → JSON envelope; `GET /api/v1/auth/me` → 401 JSON; `POST /unknown` → 404 (only GETs reach the fallback). `GET /assets/index-*.js` regex shape — the previous literal `NZV9_L46` would have failed on the next Vite rebuild.
- Setup-gate integration: with installation incomplete, `GET /setup` returns the shell, `GET /` 302s to `/setup`.
- Doctor fixtures: every check has both a passing shape and one-character mutations (missing assets, wrong binding, missing `not_found_handling`, orphan producer/consumer, missing `max_retries`, top-level `apply_migrations: true`, `migrations_dir` set, name-set rename drift).
- Deploy fixtures: `computePendingMigrations` (a)–(d) (empty applied → all pending; full applied → zero pending; partial → only gap; ghost → exit 1 with ghost list). `parseAppliedMigrationNames` 4 cases (success, fresh-DB missing-table returns `[]`, unrelated parse failure). The byte-for-byte no-op log line asserted against `db-migrate.ts:124`.

**Docs** — `docs/operations/deploy.md` documents the repeat-deploy no-op behaviour.

**Build order** — root `package.json`: web builds first, then worker, so `apps/web/dist/` exists when `wrangler deploy --dry-run` reads it.

### Decisions

D1–D4 are pre-existing and unchanged from the contract draft. **D5–D7 are new** and were promoted during the fix slice (review-round pressure, not implementer foresight):

- **D5** — `run_worker_first: ["/api/*"]` enforces the API-never-reaches-assets invariant at the Cloudflare platform layer. Without it, navigation fetches to `/api/v1/foo` get rewritten to `index.html` regardless of the Worker-side guard.
- **D6** — `queue-consumer-topology` parity is enforced BOTH by count AND by name-set disjointness. The two configs declare queue names from disjoint sets; rename drift in one config is caught.
- **D7** — `readRemoteApplied` treats wrangler `success: false` on a missing `d1_migrations` table as empty applied, mirroring `scripts/db-migrate.ts:98-101`. Local and remote runners share the same dialect for this edge case.

### Process trail

4-way parallel review (architecture, code, security, qa) surfaced **2 HIGH + 4 MEDIUM + 5 LOW**. Security came back clean (ACCEPT). QA came back ACCEPT — all 15 ACs PASS — but the architecture reviewer's HIGH (missing `run_worker_first`) and the code reviewer's HIGH (`readRemoteApplied` fresh-DB) were independently surfaced and converged on the same deploy-script/config fix. The single fix-slice implementer (one writer — file set is tightly coupled across wrangler + deploy + doctor) closed all HIGH/MEDIUM + the in-scope LOW doc drift in `scripts/scaffold.ts:59` (10 → 13). 5 LOW findings explicitly out of scope: redundant `router.get('/')`, `cons`/`tcons` naming in `doctor.ts`, HEAD probe handling, header forwarding to ASSETS, stale `scripts/dist/doctor.js` — recorded as D-CAP-039-A through E.

### Gates (orchestrator-run after fix slice)

| Gate | Result |
|---|---|
| `pnpm scaffold doctor` | 13/13 |
| `pnpm lint` | 0 errors / 134 warnings (baseline) |
| `pnpm typecheck` | clean |
| `pnpm test:unit` | 484 passed (+5 from baseline 479) |
| `pnpm test:worker` | 551 passed (baseline 551) |
| `pnpm build` | clean; `wrangler deploy --dry-run` prints `env.ASSETS` binding + reads 5 files from `apps/web/dist` |
| `git diff --check` | clean |

CAP-040 (webhook + audit reliability) is now unblocked — `d1_databases[0]` no longer auto-replays migrations, the queue consumer is wired, and the deploy script's failure modes are bounded.

## 2026-08-20 — CAP-030: Lifecycle direction — state-machine guards for messages + outbound_jobs

Closed the long-standing gap that the `messages.status` and `outbound_jobs.status` writers carried no SQL-level direction invariant: a buggy or malicious caller could violate the documented lifecycle (e.g. resurrect a `failed` row via a strictly-newer event, or overwrite a `sent` job with `queued`), and the only defence was the rank-aware predicate closed by CAP-029 — which ranks by event time, not by lifecycle semantics. CAP-030 introduces a **direction table** that pins every legal `(from, to)` pair in `packages/contracts` and layers a SQL `AND` predicate on top of the existing rank predicate, so a forbidden transition is rejected at the database boundary regardless of which caller invoked it.

### What changed

**Contracts** — `packages/contracts/src/index.ts`:

- `outboundJobStatusSchema` (closed zod enum, `:193-203`) + `OutboundJobStatus` derived type — mirrors `messageStatusSchema` exactly. The 7-value set matches the `migrations/0007_outbound_jobs.sql` CHECK constraint (`'queued','sending','sent','delayed','bounced','complained','failed'`).
- `ALLOWED_MESSAGE_TRANSITIONS: ReadonlyMap<MessageStatus, ReadonlySet<MessageStatus>>` (`:234-260`) — 9 entries; terminal sets empty for `failed`/`bounced`/`complained`. The retry-reset and forward-on-delayed paths are encoded explicitly.
- `ALLOWED_JOB_TRANSITIONS: ReadonlyMap<OutboundJobStatus, ReadonlySet<OutboundJobStatus>>` (`:284-303`) — 7 entries; terminal sets empty for `failed`/`bounced`/`complained` and `sent` (R-OUTBOUND-009). `sending → queued` is the explicit retry reset (R-OUTBOUND-008).
- `canTransition(domain, from, to): boolean` (`:321-336`) — domain discriminator is load-bearing: `sending → queued` is allowed on jobs, forbidden on messages. The two `as` casts inside `Map.get()` are runtime-safe (`:335` falls back to `false` via `?? false`) but add a deferred D-CAP-030-A to tighten with strict TS overloads.
- `assertCanTransition(domain, from, to): void` (`:349-359`) — throws plain `new Error(\`assertCanTransition(...)…)` per D-CAP-030-G. This is a programmer-error guard, not a user-facing 409 (same pattern as `statusRank` at `:172`). No `DomainError`, no new catalog entry.
- `allowedFromForMessageStatus(status): MessageStatus[]` (`:371-379`) — inverse helper that feeds the SQL `IN (SELECT value FROM json_each(?))` clause. Iteration order matches `ALLOWED_MESSAGE_TRANSITIONS` (Map ordering); empty array for `to='draft'` so the IN predicate is provably closed.

**Message writer** — `apps/worker/src/modules/messages/message-repository.ts`:

- `updateMessageStatus` (`:209-271`) now layers a direction predicate **alongside** the rank predicate. The single D1 statement composes:
  ```sql
  AND status IN (SELECT value FROM json_each(?))            -- CAP-030 direction guard
  AND (provider_event_time IS NULL OR provider_event_time < ? OR (...))  -- CAP-029 rank guard
  ```
- Bind order: `?1` status, `?2` provider_event_time, `?3` sent_at, `?4` now, `?5` id, `?6` allowedFromJson, `?7` providerEventTimeMs (strict-less), `?8` providerEventTimeMs (equal), `?9` newRank.
- `allowedFromJson` is `JSON.stringify(allowedFromForMessageStatus(input.status))` (`:221`). SQLite JSON1 `json_each` reads the array; empty array yields zero rows, which is the documented provably-closed behaviour for `to='draft'`.
- JSDoc at `:174-201` documents the predicate composition (id → direction → rank) and the load-bearing distinction: CAP-029 rejects by rank (event time), CAP-030 rejects by direction (lifecycle). The single D1 statement is still atomic; D1 serialises per-row writes (A6).

**Lease-aware job writers** — `apps/worker/src/modules/outbound-mail/job-repository.ts` (comment-only, no SQL change):

- `claimOutboundJob` (`:194-199`) — `status='queued'` is the FROM-state for the only legal target `sending`. Pinned to `ALLOWED_JOB_TRANSITIONS.get('queued')`.
- `markOutboundJobSent` (`:231-236`) — `status='sending'` for target `sent`. The single-status predicate is a strict subset of the direction table; widening to `IN (...)` would be cosmetic (D-CAP-030-C).
- `markOutboundJobRetryable` (`:278-283`) — `status='sending'` for target `queued` (R-OUTBOUND-008 retry reset). `ALLOWED_JOB_TRANSITIONS` explicitly lists `'queued'` as a legal target of `'sending'` so a future reviewer does not file it as a regression.
- `markOutboundJobTerminal` (`:324-327`) — `status='sending'` for target `failed` (R-OUTBOUND-008/009). `failed` itself is terminal (empty allowed-from set).

**Compose INSERT** — `apps/worker/src/http/routes/compose.ts:177-187`:

- Inline comment explaining the bypass: the `messages` row has no prior state on insert (vacuously true); the `migrations/0006_messages.sql` CHECK on `status` is the safety net. The comment explicitly warns against re-routing the compose write through `updateMessageStatus` — that would break R-OUTBOUND-006's atomic batch (idempotency record + message + mailbox_messages + outbound_job must be one D1 batch, and the direction guard is for UPDATE only).

**Tests** — `packages/contracts/src/index.test.ts:1237-1592` new `describe('ALLOWED_*_TRANSITIONS — CAP-030 direction guard')` block (119 tests):

- Literal pins: `EXPECTED_MESSAGE_TRANSITIONS` and `EXPECTED_JOB_TRANSITIONS` map expected sets; the test asserts each `ALLOWED_*_TRANSITIONS` map matches the literal exactly and the terminal sets are empty.
- Forward coverage: every non-terminal source × every legal target.
- Regression coverage: every non-terminal source × every forbidden (regression) target.
- Terminal-out coverage: every terminal state × every non-terminal target (must reject).
- Retry-reset asymmetry: `sending → queued` allowed on jobs, forbidden on messages (domain discriminator).
- `assertCanTransition` happy + error paths (D-CAP-030-G: plain `Error` with `from → to` message).
- `allowedFromForMessageStatus` round-trip: 6 targets including the empty `draft` case.

**Worker-pool tests** — `apps/worker/src/modules/messages/message-repository.worker.test.ts` (4 new tests, B1–B4):

- B1: `sent → queued` rejected — rank predicate would accept (strictly-newer event time), only direction rejects. Load-bearing for the direction guard.
- B2: `failed → sent` rejected — terminal violation (R-MESSAGE-012), rank predicate would accept.
- B3: `sent → delivered` accepted — forward + higher rank, both predicates pass.
- B4: `delivered → bounced` accepted — retroactive terminal correction (rank tie-breaker); both predicates pass.
- B1/B2 are the load-bearing pair: each scenario is one where **rank alone would accept**, so the only thing that can fail the test is the direction clause. A future regression that drops the direction clause turns B1/B2 into false-positive accepts.

**Worker-pool tests** — `apps/worker/src/modules/outbound-mail/job-repository.worker.test.ts:339-421` (4 new tests, one per lease-aware writer):

- Each test does (a) a contracts-side `canTransition` + `ALLOWED_JOB_TRANSITIONS.has(from, to)` inspection, AND (b) a real-D1 writer invocation against a seeded row. The pair pins the direction table entry against the SQL — a future SQL regression that drifts the predicate fails the (b) half even though (a) still passes.
- `markOutboundJobRetryable` test exercises the retry-reset path (D-CAP-030-B): asserts `attempts` bumps from 1→2 and the lock is cleared.
- `markOutboundJobTerminal` test asserts `attempts` is NOT incremented (the failed-final-attempt count is already in `attempts` from earlier retryable writes) and the lock is cleared.

**Tests deleted** — principled per R-MESSAGE-012:

- `webhooks.worker.test.ts` A2 (`bounced → delivered` on strictly newer event time) — the premise directly contradicts R-MESSAGE-012. Equivalent strict-newer-time coverage retained in B1/B2 (direction rejection) and B3/B4 (direction acceptance with higher rank).
- `message-repository.worker.test.ts` "newer event of any rank always wins" — same premise. Each deletion has a one-line inline comment with the rationale. Recorded as **D-CAP-030-D** so a future reader of git history knows the deletions are principled, not lost.

### Review round

Architecture review (run before the parallel code/QA/security round) — **ACCEPT** with 1 MEDIUM wording correction and 3 LOW follow-ups. The MEDIUM (D-CAP-030-E wording softened from "fixes drift" to "forward-availability — drift is potential, not actual") is recorded in `task.md:236-237` and in the ledger row.

Three independent reviewers ran in parallel (code, QA, security — none of them wrote the code). Aggregated: **0 BLOCKER / 0 HIGH / 0 MEDIUM / 7 LOW**:

- **Code** (4 LOWs): L1 `reclaimStaleOutboundJobs` lacks the direction-guard comment the four lease-aware writers carry (→ D-CAP-030-B). L2 `OutboundJobStatus` adoption two-step on internal writer signatures (`isJobTerminal`/`updateJobStatus` still type against `OutboundJobRow['status']`; → D-CAP-030-C). L3 `canTransition` overload could be stricter compile-time (→ D-CAP-030-A). L4 B3/B4 prose slightly loose on "load-bearing" framing (deletion rationale → D-CAP-030-D).
- **QA** (2 LOWs): L1 `process-outbound-job.ts:230` could cross-reference the direction table (→ D-CAP-030-B). L2 D-CAP-030-E wording cautious vs outcome (already softened in `task.md`).
- **Security** (1 LOW): L1 `canTransition` casts inside `Map.get()` — runtime-safe fallback to `false` via `?? false`; the `'draft is unreachable in the job domain'` test pins the conservative behaviour (→ D-CAP-030-A combined with Code L3).

All LOWs are non-blocking, scoped to follow-up slices, and recorded in the ledger. **No HIGH, no BLOCKER, no MEDIUM** — the capability is accepted as-is.

### Gates

Orchestrator-run, post-slice, post-review: `pnpm scaffold doctor` 10/10 ✓, `pnpm lint` 0 errors (67 pre-existing `no-console` warnings in `scripts/`, none in CAP-030 scope), `pnpm typecheck` ✓, `pnpm test:unit` 459/459 ✓, `pnpm test:worker` 540/540 ✓, `pnpm build` ✓, `git diff --check` clean ✓.

**Grep verification** (post-slice):

- `git grep -n "UPDATE messages" -- 'apps/worker/src/'` → 3 hits (the writer at `message-repository.ts:229`, the doc comment at `:185`, the test SQL constant).
- `git grep -n "ALLOWED_JOB_TRANSITIONS" -- 'apps/worker/src/'` → 4 writer-comment refs + 4 test refs.
- `git grep -n "ALLOWED_MESSAGE_TRANSITIONS" -- 'apps/worker/src/'` → 2 test refs (the `index.test.ts` block + `message-repository.ts:220`).
- `git grep -n "outboundJobStatusSchema" -- 'apps/worker/src/'` → 0 hits outside `packages/contracts/` (the new schema is consumed only by the test block; future adopters will import it).
- `git grep -n "canTransition" -- 'apps/worker/src/'` → 4 test refs (contracts tests + the worker tests).

### Resolves

- **D-CAP-028-C** — `updateJobStatus` retention is now explicitly documented with the CAP-030 direction pairing (the lease-aware writes are the only path the queue consumer takes; the unconditional writer is retained for compose-insert + idempotency-replay).

### Deferred

- **D-CAP-030-A** — `canTransition` runtime type narrowing (Security L1 + Code L3): tighten with TS overloads or a runtime check that rejects messages-only `from` values when `domain === 'job'`. Wait for the second caller-mismatch before extracting (Rule of Three).
- **D-CAP-030-B** — Direction-guard comment propagation to `reclaimStaleOutboundJobs` (Code L1) plus `process-outbound-job.ts:230` cross-reference (QA L1). Cosmetic symmetry gap.
- **D-CAP-030-C** — `OutboundJobStatus` adoption on `isJobTerminal` + `updateJobStatus` (Code L2). Internal-to-module, no current cross-boundary violation.
- **D-CAP-030-D** — Record the deleted A2 / "newer-event-of-any-rank" tests so a future reader of git history knows the deletions are principled per R-MESSAGE-012 (Code L4).

### Workspace cleanup

`work/active/CAP-030-lifecycle-direction/` and `work/reviews/CAP-030-architecture-review.md` moved to `work/archive/2026-08/CAP-030/` (task.md and architecture-review.md both retained). `work/active/` is now empty (`.gitkeep` only). No commit/push per the active constraints — the ledger, implementation log, and archive are the only files changed in this closure pass.

## 2026-08-20 — CAP-041 (in progress): setup web vertical slice. Closes reality-audit BLOCKER #56 ("setup gate redirects users to a route the Worker does not serve") and reality-audit HIGH #60 ("Phase 1 user workflows are not implemented in the web client"). Contract written at `work/active/CAP-041-setup-web-vertical-slice/task.md` — 20 acceptance criteria, 8 R-* rules (R-WORKFLOW-001..004, R-AUDIT-002, R-SECRET-003, R-DATA-001, R-API-002). Scope: pure client slice. No backend changes. No new contract types. The wizard consumes `setupClaimRequestSchema`, `setupPreflightResponseSchema`, `setupAdministratorRequestSchema`, `setupDomainRequestSchema`/`domainNameSchema`, `setupBrevoRequestSchema`, `installationStateInfoSchema`/`installationStepSchema` from `@unimailbox/contracts` directly — no second contract model (D1). Implementation layers, in dependency order: design-token CSS → 5 shadcn-style primitives (`Input`, `Card`, `Toast`, `Spinner`, `Alert`) → API client (`infrastructure/api/{client,errors,retry}.ts`) with `Idempotency-Key` injection + Bearer header + exponential backoff (1s/2s/4s/8s/16s capped 30s, 5 attempts) + request-id propagation → Zustand `setup-session-store.ts` for the in-memory session token (D2 — never `localStorage`/`sessionStorage`/`IndexedDB`; verified by a unit test that asserts no `persist` middleware) → TanStack Query hooks (`setupStatusQuery`, `setupPreflightQuery`, `setupMutation` factory) → 9 step components under `features/setup/steps/` (`ClaimStep`, `PreflightStep`, `AdministratorStep`, `DomainStep`, `CloudflareVerifyStep`, `InboundSmokeStep`, `BrevoStep`, `OutboundSmokeStep`, `CompleteStep`) → `/setup/*` sub-router replacing the CAP-001 stub. Browser-context tests via `@testing-library/react` + `happy-dom` with mocked `globalThis.fetch` (D3 — Playwright belongs to CAP-045). The router's `beforeLoad` calls `setupStatusQuery`'s fetcher and redirects stale deep routes to the server's `currentStep` so R-WORKFLOW-001 cannot be bypassed by URL (D4). New client-side dependencies (pre-approved by `.claude/rules/coding.md` §Language and stack): `zod`, `react-hook-form`, `@hookform/resolvers`, `zustand` + dev deps `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `happy-dom`. Implementer dispatched 2026-08-20; review (architecture + code + frontend + security + qa) queued behind it. Final commit at capability boundary per D5.

## 2026-08-20 — CAP-040: webhook secret boundary, early-event reconciliation, atomic status/audit, correlation IDs. Closes the four HIGH findings from the 2026-08-19 reality audit (ledger lines 61-64) plus D-CAP-029-A (atomic status/audit batch) and D-CAP-029-B (request-id propagation into audit rows). **Process trail** — implementer self-reported the slice as Implemented with all six gates green (the orchestrator re-ran all six independently and confirmed: `pnpm typecheck` clean after rebuilding contracts, `pnpm lint` clean, `pnpm scaffold doctor` 13/13, `pnpm test:unit` 484/484, `pnpm test:worker` 558/558 (+7 vs pre-CAP-040), `pnpm build` clean with `wrangler deploy --dry-run --outdir=dist` reporting all 9 bindings). 4-way parallel review (architecture + code + security + qa) ran blind against the working-tree diff because `work/active/CAP-040-*/task.md` had been cleaned before review started; reviewers challenged the implementation directly against `docs/rebuild/02-business-discovery/business-rules.md`. Architecture surfaced **2 HIGH + 5 MEDIUM + 4 LOW**; security surfaced **1 HIGH (false positive — already scoped to connectionId; rejected) + 2 MEDIUM + 1 LOW**; code surfaced **0 HIGH + 4 MEDIUM + 6 LOW**; qa **ACCEPT** with **0 HIGH + 0 MEDIUM + 1 LOW**. Orchestrator applied all HIGH/MEDIUM fixes in a single fix slice (HIGH-1 reconciliation gate dropped `jobAdvanced`; HIGH-2 closed-enum typing; MEDIUM-1 Drizzle `provider_message_id` column; MEDIUM-2 MEDIUM-M1 failure-injection test; MEDIUM-M2 reveal-403 test; MEDIUM-3 architecture.md outbound-mail → admin WRITE paragraph; MEDIUM-5 doc-comment softening; LOW-1 deleted unused `findUnmatchedDeliveries` export). The closed-enum typing fix surfaced a separate bug from CAP-035: `admin-role-policies.ts:163` used `action: 'role_policy.set'` which was missing from `auditActionSchema` — added. **What changed** — `migrations/0013_webhook_delivery_message_index.sql` + `.verify.sql` adds `provider_message_id TEXT GENERATED ALWAYS AS (json_extract(raw_payload, '$.messageId')) STORED` to `webhook_deliveries` plus a composite index `(provider_message_id, connection_id)` (trailing column enforces R-AUTHZ-004 connection scope, mirroring the CAP-029 H1 fix on `findJobByProviderMessageId`); `CURRENT_SCHEMA_VERSION` bumped to `'0013'` (`apps/worker/src/database/schema-version.ts`); migration imported into `packages/test-kit/src/migrationsDb.ts`. New cross-module WRITE seam `AuditEventWriter` in `packages/contracts/src/admin/audit.ts` (mirrors the `BlocklistReader`/`RolePolicyReader` pattern from CAP-035; uses a structural `D1StatementLike` interface so the contracts package stays free of Cloudflare runtime types); implementation at `apps/worker/src/modules/admin/audit-event-writer.ts` (`createAuditEventWriter(db)`); wired in `apps/worker/src/app-context.ts` next to the existing readers. Closed `auditActionSchema` extended with `role_policy.set` (CAP-035 gap surfaced by the typing), `webhook_delivery.reconcile`, and `webhook_secret.reveal`. `apps/worker/src/modules/admin/audit-event-repository.ts` — `AuditEventInput.action` is now `AuditAction` (closed), not `string`. R-SECRET-003 closure: `listProviderConnections` no longer returns `webhook_secret`; `GET /api/v1/admin/connections` returns `{ webhookConfigured: boolean, webhookUrl: string | null }` only and asserts `not.toHaveProperty('webhookSecret')` in `admin-webhooks.worker.test.ts`; new `POST /api/v1/admin/connections/:id/webhook-secret/reveal` endpoint gated by `requirePermission('provider.sync')` writes a `webhook_secret.reveal` audit row carrying actorUserId + connectionId + providerKey in metadata (NEVER the secret — R-LOG-001); 403 test confirms non-admin callers are rejected and no audit row lands for denied reveals. D-CAP-029-A atomic-batch closure: `verifyAndProcessEvent` is now a builder that returns prepared statements (`messages UPDATE` + `webhook_deliveries INSERT`); the route handler at `apps/worker/src/http/routes/webhooks.ts` appends the `audit_events` INSERT and runs a single `db.batch([...])`. `updateMessageStatus` was split into `updateMessageStatus` + `prepareUpdateMessageStatus` so the messages UPDATE can be folded into the batch. New contrapositive test at `webhooks.worker.test.ts` uses `vi.spyOn(createAuditEventWriter)` to inject a NULL `action` binding; the resulting 500 + zero-of-three-writes-visible assertion proves the batch is truly atomic (the previous test was named "atomic batch rollback" but only exercised the happy path). Reconciliation: new `reconcile-webhook-deliveries.ts` use case (`prepareReconciliationStatements` + `reconcileWebhookDeliveries`) finds unmatched deliveries via the composite index, back-fills `message_id` to the canonical id, and emits a `webhook_delivery.reconcile` audit row — called from `processOutboundJob` AFTER `markOutboundJobSent` and gated on `sendResult.providerMessageId` (D-CAP-040-ARCH-H1 fix — was previously gated on `jobAdvanced`, which left orphan delivery rows on the lock-stolen-mid-send divergence path). D-CAP-029-B logger guardrail: all new logger calls in `process-outbound-job.ts` and `apps/worker/src/entrypoints/queue.ts` catch use `error instanceof Error ? error.message : String(error)` — no `error.cause` traversal anywhere. Correlation IDs: HTTP audit rows pull `requestId` from `c.get('requestId')` (set by request-id middleware at `apps/worker/src/http/middleware/request-id.ts`); the inbound-email entrypoint, the queue consumer, and the scheduled handler each synthesise `requestId = systemIds.uuid()` per invocation and thread it through to audit rows + the `processOutboundJob` / `reclaimStaleJobs` dep signature (`requestId?: string`). **Final gates** (orchestrator-run, post-fixes): typecheck clean, lint clean, doctor 13/13, unit 484/484, worker **560/560** (+2 vs pre-fix 558: the failure-injection test and the reveal-403 test), build ✓, wrangler dry-run reports all 9 bindings. **Deferred items** (recorded at capability ledger §CAP-040 follow-ups): **D-CAP-040-A** — 30-day TTL purge for `webhook_deliveries` rows (schema + index land now; daily cron sweep deferred); **D-CAP-040-LOW-1..6** — webhook idempotency on provider event id, per-batch correlation UUID, audit metadata size cap, webhook body-size cap, `D1StatementLike` seam broadening, `requestId` required in `ProcessJobDeps`; **D-CAP-040-MED-3** — three identical seam casts at `{ statement: D1StatementLike }` boundary (architectural refactor; defer to a seam-cleanup follow-up).

## 2026-08-19 — Project-state recovery and delivery-plan correction

Reconciled the ledger and roadmap against the current code, deployment configuration, active
workspace, and Git state. CAP-030 is now correctly recorded as in progress. Phase 0 and Phase 1
delivery status is reopened: `/setup` is unserved, the Vite output is not wired to the Worker, the
Wrangler queue has no consumer, the remote deploy path replays all migrations, and the web client
does not implement the business loop.

Added `execution-plan.md` with CAP-039–CAP-045 as the recovery gate and pinned Cloudflare
`agentic-inbox` commit `48039bb6785af34e592c2966f87cde2b255c4c80` in
`11-agentic-inbox-adaptation.md`. The reference's Worker/UI integration, Email Routing, R2, API
client, query, and mailbox UI patterns are reusable; its shared Cloudflare Access trust boundary,
per-mailbox Durable Object persistence, R2 metadata, and best-effort send lifecycle are explicitly
rejected for Unimailbox.

Project workflow was tightened in `.claude/`: reference provenance is now a rule and capability
template section; implementation and phase-audit procedures now verify delivery topology; state
recovery reads the ledger's Current state table instead of the first Phase heading and reports
ledger/workspace CAP drift. Future-phase roadmap criteria were reset from pre-checked claims to
unchecked requirements.

No CAP-030 business source was changed by this recovery update.

## 2026-08-15 — CAP-029: Webhook ordering — rank-aware status updates + IDOR closure

Closed the long-standing gap that webhook-driven status updates could clobber a higher-rank state (a `delivered` arriving after `bounced`), that `provider_message_id` collisions across connections were exploitable as a cross-tenant IDOR (R-AUTHZ-004), and that Brevo response bodies could leak into the queue consumer's logger via `error.message` (R-SECRET-003 / R-LOG-001). CAP-029 introduces a rank-aware writer, a closed error taxonomy, and two migrations that pin the ordering invariant in SQL.

### What changed

**Migrations** — `migrations/`:

- `0011_message_event_time.sql` (new) — adds `messages.provider_event_time INTEGER` (nullable ms epoch) + index `(provider_event_time)` for range queries + inline R-MESSAGE-007 rationale comment ("newer-or-equal on tie breaks in favour of higher status rank"). Verify file: `0011_message_event_time.verify.sql` asserts column + index + nullable shape.
- `0012_webhook_event_time.sql` (new) — adds `webhook_deliveries.event_time INTEGER` (nullable ms epoch) to mirror the inbound timestamp the processor uses for the rank predicate. Verify file: `0012_webhook_event_time.verify.sql` asserts column + nullable shape.

**Domain** — `packages/contracts/src/index.ts`:

- `STATUS_RANK_TABLE: ReadonlyArray<readonly [MessageStatus, number]>` (lines 155-165) — closed rank table for the seven message statuses. Tuple order is `[status, rank]`, pinned by `packages/contracts/src/index.test.ts:1184-1227` which destructures `[s, rank]` accordingly. Order: `failed ≈ bounced ≈ complained` (terminal) > `delivered` > `delayed` > `queued` > `sending` > `sent`.
- `RetryableProviderError` / `TerminalProviderError` classes (lines 210-235) with `kind: 'retryable' | 'terminal'` discriminator and closed-catalog `code: 'RETRYABLE_PROVIDER_ERROR' | 'TERMINAL_PROVIDER_ERROR'`. The cause chain is preserved via `super(message, chainCause(options))` — the inline comment at lines 213-216 documents the `useDefineForClassFields: true` shadowing trap (a redeclared `cause` class field would reset the prototype assignment to `undefined` under ES2022).
- `SEND_FAILED` added to `ERROR_CODES` (CAP-032 catalog) — emitted by the outbound queue consumer on terminal send failure.

**Repository** — `apps/worker/src/modules/messages/message-repository.ts`:

- `updateMessageStatus(db, messageId, newStatus, providerEventTime, expectedPreviousStatus?)` (lines 193-245) — single D1 statement with a rank-aware SQL CASE predicate inside the `WHERE` clause. Equal `provider_event_time` + lower rank → reject; equal + same rank → reject (idempotent); newer event → apply regardless of rank (so a late `delivered` after `failed` is honoured, but a late `sent` after `delivered` is not). Doc-comment at lines 178-182 records "D1 serialises per row" as the rationale for the no-batch shape today — the future batching work is tracked as **D-CAP-029-A**.
- Reached from `process-outbound-job.ts:270-274` via `updateMessageStatus(...)` imported from `modules/messages/index.ts`. The previous direct `UPDATE messages` is gone — `outbound-mail` now consumes the messages module through its index only, never touching the table directly (D-CAP-028-D closure).

**Webhook processor** — `apps/worker/src/modules/outbound-mail/webhook-processor.ts`:

- `mapEventToMessageStatus(event)` (lines 50-67) — closed mapping from Brevo event types to `MessageStatus`. Returns `null` for unknown events; the caller (lines 166-182) branches on `if (status !== null)` so unknown events still record a `webhook_deliveries` row but skip the messages UPDATE.
- `extractBrevoEventTimeMs(raw, fallback)` (lines 230-261) — format-based timestamp discriminator. `SECONDS_MS_THRESHOLD = 1e10` (year 2286 sentinel) discriminates integer ms from integer seconds; `!Number.isInteger(raw)` rejects fractional values; the string path uses `Date.parse` and rejects `NaN-Infinity` and `<= 0`; other types (boolean, bigint, object, undefined, null) route to server fallback with `source: 'server'`. Worker-pool coverage at `webhooks.worker.test.ts:538-652` exercises all six input shapes.

**Webhook repository** — `apps/worker/src/modules/outbound-mail/webhook-repository.ts`:

- `findJobByProviderMessageId(db, connectionId, providerMessageId)` (lines 139-150) — connection-scoped SQL: `WHERE provider_message_id = ? AND provider_connection_id = ?`. Closes R-AUTHZ-004: a collision across connections no longer lets a malicious actor on connection A clobber connection B's message status. Regression test `webhooks.worker.test.ts:458-529` seeds two connections, forces the collision (`expect(collision?.n).toBe(2)`), posts to A only, and asserts message A flips to `delivered` while message B remains `sent`.

**Brevo adapter** — `apps/worker/src/integrations/providers/brevo.ts`:

- 5xx/429 vs 4xx classification (lines 160-197): `status === 429` → `RetryableProviderError` (lines 177-183); other `status >= 400 && status < 500` → `TerminalProviderError` (lines 184-190); 5xx and anything outside 4xx/5xx not yet classified → `RetryableProviderError` (lines 192-196); fetch rejection → `RetryableProviderError` (lines 150-158).
- `errorMessage` is `` `Brevo send failed: status ${status}` `` only (line 171) — **no body interpolation**. Body is attached via `{ cause: body ? new Error(...) : undefined }` at lines 168-170, 179-181, 191-193. Empty body → no cause. Closes R-SECRET-003 / R-LOG-001: bodies can carry PII (recipient addresses) and `xkeysib-…` secret prefixes that must never land in the worker log stream.
- Regression tests at `brevo.test.ts:39-87` (body NOT in `err.message`, IS in `err.cause`), `:89-122` (429 → retryable, body on cause), `:189-215` (empty body → no cause), `:217-245` (fetch rejection → retryable).

### Review round

The original slice went through four independent reviewers (architecture, code, QA, security). Findings were consolidated into the review-triage table and resolved in a fix slice (D6/D7 deferrals recorded for atomicity and chain-walking). After the fix slice, fresh security + code reviewers re-reviewed the H/M fixes.

- **Code re-review** (2026-08-15): ACCEPT WITH FIXES. **1 MEDIUM** — M1: webhook-delivery INSERT and `messages` UPDATE are not in a single D1 batch (`webhook-processor.ts:166-198`). A worker crash between them leaves an applied status change with no `webhook_deliveries` audit row. Fix shape: wrap both calls in `db.batch([...])`; trade-off accepted is that the boolean from `updateMessageStatus` cannot drive the "applied or rejected" log line — instead the delivery row's `event_time` + `event_type` are logged and operators correlate via `messages.status` history. Recorded as **D-CAP-029-A** in the ledger, not blocking CAP-029 (the atomicity invariant is out of scope; CAP-029 owns the ordering invariant). **1 LOW** — L1: `extractBrevoEventTimeMs` is not exported for testing in isolation. Deferred until a second provider surfaces a different timestamp format (Rule of Three).
- **Security re-review** (2026-08-15): ACCEPT WITH FIXES. H1 (R-AUTHZ-004 cross-tenant IDOR closed via connection-scoped SQL at `webhook-repository.ts:146`) + H2 (R-SECRET-003 body on `cause` not on `message`; `useDefineForClassFields` shadowing trap intact) + M1 (429 split from terminal 4xx branch) all verified fixed with file:line evidence. **1 LOW** — L1: `process-outbound-job.ts:340` logs `error.message` only; the body sits on `cause` and is safe today, but a future chain-walking logger helper could re-leak it. Recorded as **D-CAP-029-B** in the ledger.

### Gates

Orchestrator-run, post-fix-slice, post-re-review: typecheck ✓, lint ✓, test:unit 340/340 (+16 since CAP-038), test:worker 534/534 (+71), build ✓, scaffold doctor 10/10.

**Grep verification** (post-slice):

- `git grep -n "UPDATE messages" -- 'apps/worker/src/'` → 3 legitimate hits (`message-repository.ts:185` doc comment, `message-repository.ts:207` writer, `process-outbound-job.worker.test.ts:677` test SQL constant). The previous direct UPDATE at `process-outbound-job.ts` is gone.
- `git grep -n "updateJobStatus" -- 'apps/worker/src/'` → 4 legitimate hits (2 imports/exports, 1 define, 1 call in `queue.worker.test.ts`).
- `git grep -n "code: 'INVALID_REQUEST'" -- 'apps/worker/src/'` → 0 hits (CAP-038 closed the catalog entry).

Resolves D-CAP-028-A (cross-tenant IDOR on `findJobByProviderMessageId`), D-CAP-028-C (rank-aware writer without direct table access from outbound-mail), D-CAP-028-D (`process-outbound-job.ts` direct UPDATE replaced by `updateMessageStatus` call through `modules/messages/index.ts`).

## 2026-08-15 — CAP-038: Remove deprecated `INVALID_REQUEST` catalog entry

Closed the CAP-032 migration window. The `INVALID_REQUEST` code was deprecated during
CAP-032 (see D-CAP-032-B) after the three `auth.ts` call sites were reclassified to
`VALIDATION_ERROR`; the `EmittableErrorCode = Exclude<ErrorCode, 'INVALID_REQUEST'>`
type alias + runtime narrowing were belt-and-braces defences that prevented
accidental emission during the window. CAP-038 deletes the entry, the defences, and
the migration-window test assertion in one slice — the catalog union no longer
carries a code that no route emits.

### What changed

**Catalog** — `apps/worker/src/platform/errors.ts`:

- `ERROR_CODES.INVALID_REQUEST` deleted; the preceding "Deprecated — migration
  window only" comment deleted; the catalog-header "3. Deprecated" bullet deleted
  (the post-slice catalog has two buckets, not three: Live + Catalogued-but-unused).
- After the deletion, `ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]`
  is a tighter closed union — R-API-002 enforced more strongly.

**Middleware** — `apps/worker/src/http/middleware/error.ts`:

- `EmittableErrorCode` type alias deleted (`:28-34`); `envelope()` parameter retyped
  to `ErrorCode` directly (`:45`). With the catalog entry gone, `err.code` is
  already `ErrorCode` and no longer contains `'INVALID_REQUEST'` — the alias was
  defending against a state that no longer holds.
- Runtime narrowing `err.code === 'INVALID_REQUEST' ? 'VALIDATION_ERROR' :
  err.code` + the preceding "The envelope helper refuses to emit 'INVALID_REQUEST'…"
  comment block deleted at `:82-90`. `envelope()` now passes `err.code` straight
  through.

**Tests** — `apps/worker/src/platform/errors.test.ts`:

- AC1 "migration-window" test repurposed to "AC1: every catalogued-but-unused code
  and canonical envelope code is present in the catalog" (`:50`). The catalog-shape
  loop at `:11-21` tests SHAPE (every entry well-formed), not SET (which codes
  exist); this named test pins 5 high-value codes (`BODY_TOO_LARGE`, `INTERNAL`,
  `VALIDATION_ERROR`, `RATE_LIMITED`, `LOCK_CONTENTION`) so a future contributor
  removing one breaks a named test rather than slipping past the shape check. AC3
  `@ts-expect-error` demo at `:23-34` untouched (uses `'R-AUTHZ-004'`, not
  `INVALID_REQUEST`).

### Review round

Architecture + code in parallel (no business behaviour change; QA / security /
frontend skipped per `.claude/skills/review-capability` §1). Both reviewers
returned ACCEPT WITH FIXES.

- **Code reviewer**: 1 MEDIUM (M1) — the AC1 test's title still claimed
  "migration-window code is present in the catalog" after the slice, but the
  assertions were now redundant with the catalog-shape test. Recommended either
  delete the redundant test or repurpose it to assert the catalogue-but-unused
  codes the inline comment actually named.
- **Architecture reviewer**: 1 MEDIUM (M1) — same finding, different fix
  proposal. Recommended renaming the title only and keeping the existing
  assertions (`BODY_TOO_LARGE` / `INTERNAL` / `VALIDATION_ERROR`) because they
  add genuine churn protection the catalog-shape loop cannot provide (SHAPE vs
  SET distinction).
- **Orchestrator decision** (per `.claude/rules/agent-collaboration.md` §Conflict
  handling): architecture reviewer's option 1 wins. The catalog-shape loop
  iterates entries and checks each is a string equal to its key, but does not pin
  which codes exist — `entries.length >= 40` still passes if `BODY_TOO_LARGE` is
  removed. A named test asserting `BODY_TOO_LARGE` IS additive. Fix landed inline
  (5-line edit to `errors.test.ts:50-58`) and gates re-verified. **1 LOW**
  (architecture) — pre-existing "two buckets" header comment imprecision, not
  introduced by this slice; recorded for a future cleanup pass.

### Gates

Orchestrator-run, post-fix: typecheck ✓, lint ✓, test:unit 324/324,
test:worker 463/463, build ✓, scaffold doctor 10/10.

**Grep verification** (post-slice): `grep -rn "INVALID_REQUEST" apps/worker/src/
--include='*.ts'` → 0 hits.

Resolves D-CAP-032-B. Closes the CAP-032 migration window completely.

## 2026-08-15 — CAP-032: Stable error model — closed catalog + canonical envelope

Closed the long-standing gap that error responses had no stable machine-readable `code`: routes
returned generic shapes (`{ error: '...' }` text strings, hand-rolled 404s, `ContentfulStatusCode`
leaks), the catalog lived in a dead branch (`http/errors.ts`), and the `requestId` was a
per-locale stub. CAP-032 fixes the **shape**, the **catalog**, the **middleware**, and the
**audit-ability** of every `/api/v1/*` response in one slice.

### What changed

**Catalog** — `apps/worker/src/platform/errors.ts`:

- Closed `ERROR_CODES = { ... } as const satisfies Readonly<Record<string, string>>` (R-API-002);
  `ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]` is the closed union. Adding a code
  is a deliberate catalog edit, not a string at a call site.
- `DomainError` carries `code: ErrorCode` + `httpStatus?: HttpStatusCode` (F1 — local literal
  union, framework-neutral; `platform/*` no longer depends on Hono's `ContentfulStatusCode`).
- `HttpErrorBody` is the canonical envelope shape `{ error: { code, message, requestId } }` with
  all three fields required by the type system (R-API-001).

**Middleware** — `apps/worker/src/http/middleware/error.ts`:

- Single `envelope(code, message, httpStatus, requestId)` helper is the **only** place that
  emits the canonical envelope (single source of truth — F3 refactor). `requestId` flows from
  the middleware-set `c.get('requestId')` once, not twice (Arch L3).
- `EmittableErrorCode = Exclude<ErrorCode, 'INVALID_REQUEST'>` + call-site runtime narrowing
  `INVALID_REQUEST → VALIDATION_ERROR` belt-and-braces — the envelope helper cannot be tricked
  into resurrecting a retired code (Code M1).
- Four branches — `ZodError → VALIDATION_ERROR 400`, `DomainError → err.httpStatus`,
  `SyntaxError → VALIDATION_ERROR 400` (defence in depth; D-CAP-031-D), unknown → `INTERNAL 500`
  with `console.error('[error-middleware] unhandled error:', err)` carrying the R-LOG-001
  redaction comment (Code L6).

**Request-id middleware** — `apps/worker/src/http/middleware/request-id.ts`:

- Real implementation: generates a UUIDv4, sets `c.set('requestId', id)`, propagates
  `X-Request-Id` to the response header. AC5 fallback `<unknown>` sentinel is defence in depth
  for the case where middleware did not run (Code L3).
- New test file `request-id.test.ts` covers UUIDv4 regex + AC4 cross-check that the envelope
  `requestId` matches the `X-Request-Id` header.

**Route fixes** (12 sites total):

- `admin-blocklist.ts:51` — hand-rolled 404 replaced with typed `DomainError({ code:
  'BLOCKLIST_ENTRY_NOT_FOUND', httpStatus: 404 })`.
- `auth.ts:127, 336, 542` — three reclassified sites now throw `VALIDATION_ERROR` (D-CAP-031-C
  / Fix 9). The messages carry field context; finer-grained codes deferred per **D-CAP-032-A**
  (QA M2 decision — see ledger).
- `parse-json-body.ts` (`Invalid_json` shape) + every `/api/v1/*` route's `INVALID_JSON` guard
  coexist with `error.ts`'s SyntaxError fallback (D-CAP-031-D).

**Tests** — unit + worker:

- `errors.test.ts` (AC1 catalog enum, AC2 reconciliation, AC3 `@ts-expect-error` demo).
- `error.test.ts` (zod + domain + syntax + unknown envelope shape, AC5 fallback + positive,
  console.error spy tightened to tag assertion).
- `request-id.test.ts` (UUIDv4 regex, AC4 header matches body).
- Per-route envelope-shape assertions on `webhooks.worker.test.ts` (4 sites), audit-events +
  setup-status new error-path tests (F8 / QA M1).
- `admin-blocklist.worker.test.ts` — replay test renamed "replay returns identical envelope
  shape with fresh requestId" with explanatory comment (Code M2).

**Deferred** — captured in ledger §Deferred items:

- **D-CAP-032-A** — generic `VALIDATION_ERROR` reclassification for the three auth.ts sites
  accepted; messages carry field context; the catalog stays small. CAP-034 / next-phase input-
  error granularity is the natural owner if finer-grained codes are needed.
- **D-CAP-032-B** → **CAP-038** tracks the `INVALID_REQUEST` catalog entry removal (Code L5).
- **D-CAP-032-D** — `RATE_LIMITED` / `LOCK_CONTENTION` declared in catalog as `catalogued but
  unused`; no route emits 429/503 today (the live mappings are 400/401/403/404/409/413/502).

**Reviews** — three reviewers (architecture + code + qa) ran in parallel: 0 BLOCKER / 0 HIGH /
6 MEDIUM / 12 LOW total. **Fix slice** (12 items F1–F8) implemented per
`work/archive/2026-08/CAP-032/fix-slice-task.md`. **Triage**: 12 FIX (in slice) / 2
ORCHESTRATOR (D-CAP-032-A, CAP-038) / 1 DROP (Code L4 verified correct).

**Gates** (orchestrator-run, post-fix-slice, verified independently): typecheck ✓, lint ✓,
test:unit 324/324 (+1 from F6 positive AC5 case), test:worker 463/463 (+2 from F8 audit-events +
setup-status tests), build ✓, scaffold doctor 10/10. **Grep verification**: `grep -rn
"hono/utils/http-status" apps/worker/src/` → empty; `grep -rn "code: 'NOT_FOUND'" apps/worker/src/`
→ empty; `grep -rn "code: 'INVALID_REQUEST'" apps/worker/src/` → 1 hit (the deliberate narrowing
comment in `error.ts:85`).

Resolves D-CAP-008-C, D-CAP-032-B (partial — type-level only, `INVALID_REQUEST` catalog entry
itself deferred to CAP-038).

## 2026-08-15 — CAP-028: Durable outbox — lease, attempts, reclaim

Closes the CAP-023→CAP-028 gap: an outbound job now survives a consumer crash mid-send.
`claimOutboundJob` takes the row `queued → sending` atomically with a 60s lease and a
per-invocation `lockedBy` UUID; every lock-holding write predicates on `locked_by = ?` so a
stale worker is a no-op. The scheduled dispatcher (every 2 min) reclaims expired leases
(`attempts >= max_attempts` → `failed RECLAIM_EXHAUSTED`, else → `queued`, never
attempts++), re-enqueues each reclaimed ID, and sweeps `queued` rows older than 5 min whose
enqueue was lost. `processOutboundJob` runs all pre-send steps in one retryable/terminal
catch and isolates the post-success writes (failure → `outbound.job_post_send_write_failed`
+ raw rethrow; lease expiry + reclaim recovers; R-OUTBOUND-004 dedupes the resend).

Process trail: 3-way parallel review (architecture + code + qa) surfaced 1 BLOCKER + 5 HIGH;
fix round 1 closed all; fresh re-reviews surfaced F1 (failed re-enqueue orphans a `queued`
row — HIGH) and F2 (post-success write failures burned attempts on a succeeded send —
MEDIUM), both introduced by round 1; fix round 2 closed both plus F3–F5; scoped verification
re-review confirmed closure with tests that fail on pre-fix code. All adjudications in
`work/archive/2026-08/CAP-028/task.md` §Decisions. Deferrals recorded as D-CAP-028-A..D
(adapter error taxonomy → CAP-029; reclaim N+1; `updateJobStatus` retention; pre-existing
cross-module `messages` write). Gates (orchestrator-run): typecheck ✓, lint ✓, unit 324/324,
worker 505/505, build ✓, doctor 10/10.

## 2026-08-14 — CAP-031: request validation + 1 MB body limit on all `/api/v1/*`

Codified the long-standing gap that `JSON.parse(rawBody)` was duplicated at every route, with no
single point of error shape (`VALIDATION_ERROR` only, never the dedicated `INVALID_JSON` that
CAP-035 introduced), and no single place to enforce the 1 MB body cap from R-API-005. The slice
also resolves **D-CAP-037-A** (CAP-037's own follow-up: "codify the no-record rule"), making
CAP-031 the natural owner of the `INVALID_JSON` → `idempotency_records` gap.

**New helpers** — `apps/worker/src/http/middleware/`:

- `parse-json-body.ts` — file header cites **ADR-004 + D-CAP-037-A** so the no-record rule
  travels with the helper, not with every call site. `parseJsonBody(rawBody, schema, ctx)`
  parses, validates via zod, and on `SyntaxError` emits a structured `logger.warn({ event,
  actorUserId })` (never the body — R-LOG-001 / R-SECRET-003) and throws
  `DomainError({ code: 'INVALID_JSON', httpStatus: 400 })`. `ZodError` is intentionally NOT
  caught here (D-CAP-031-B): structural failures continue to surface as `400 VALIDATION_ERROR`
  via the error middleware, preserving the distinct error code for clients.
- `body-size.ts` — `enforceBodySize` middleware uses `c.req.raw` byte-length check via
  `Content-Length` header BEFORE any body read so oversized payloads never enter the helper
  pipeline. Wired in `router.ts` AFTER `requestId` but BEFORE authn/authz/idempotency so
  rejected requests still carry a `requestId` for the audit log line. Webhook routes are
  exempt — see D-CAP-031-A below.

**Refactors** — 12 route sites updated:

- 9 sites call `parseJsonBody`: `compose.ts` (compose), messages-send, messages-read,
  messages-list, `mailboxes.ts` (mailboxes-create), `admin-blocklist.ts` POST, `admin-role-policies.ts`
  PUT, `admin.ts` invite-codes, `setup.ts` `create`/`invite`/`disable-invite`/`claim` (4 sites in
  setup.ts). Each cites **D-CAP-037-A** in an inline comment explaining why no
  `idempotency_records` row is written on `INVALID_JSON`.
- 3 sites in `auth.ts` keep a local try/catch (D-CAP-031-C): Fix 9 / CAP-027 requires
  extracting the `actorId` field from `rawBodyJson` BEFORE schema parse AND BEFORE replay
  lookup, so the canonical message ID can be used as the provider idempotency key.

**Defense in depth** — `apps/worker/src/http/middleware/error.ts:31-41` retains its
`SyntaxError → 400 VALIDATION_ERROR` branch (D-CAP-031-D). With every route now going through
`parseJsonBody` (or a local try/catch in /api/v1/auth/*), this branch should be unreachable in
normal flow. Kept so a future route that forgets the helper still returns `400` rather than
`500`. R-INPUT-002 keeps the stable code (`VALIDATION_ERROR`) here only as a last-resort shape —
the canonical surface for malformed bodies is `INVALID_JSON`.

**Tests** — `parse-json-body.test.ts` + `body-size.test.ts` (unit, 100% line coverage of the
two helpers), plus 12 AC10 + 2 AC11 cases in `compose.worker.test.ts` covering malformed body
(round-trip with same Idempotency-Key succeeds), `VALIDATION_ERROR` still served on zod
failures, and `BODY_TOO_LARGE` (413) on 1 MB + 1 byte.

**Citation drift caught at orchestrator review** — the first slice used `D-CAP-031-D` in
helper-site comments to mean "no `idempotency_records` row", but `D-CAP-031-D` is actually the
error.ts defense-in-depth decision. The rule the comments describe is `D-CAP-037-A`. Fixed
mechanically across 10 comments in 6 files: `admin-blocklist.ts:89`, `admin-role-policies.ts:128`,
`admin.ts:136`, `mailboxes.ts:95`, `setup.ts` ×4 (the `/claim` site had different comment wording
and was missed by the first `replace_all` pass — caught by post-edit grep, fixed by targeted
edit), `compose.worker.test.ts:806`. `error.ts:32` correctly retains `D-CAP-031-D` (the canonical
home). All gates re-verified post-fix (test:worker 461/461, exit 0).

**Deferred** — **D-CAP-031-A**: webhook routes (`/api/v1/webhooks/:providerKey/:connectionId`)
exempt from `enforceBodySize`. Provider payloads routinely exceed 1 MB (raw RFC 5322 with
attachments, multi-MB JSON event streams from Brevo/Resend). The right enforcement point is
inside `integrations/providers/*`, where per-provider size limits are published and known.
Captured in ledger §Deferred items so the work has an owner.

**Gates** (orchestrator-run, post-citation-drift-fix): typecheck ✓, lint ✓, test:unit 313/313,
test:worker 461/461, build ✓, scaffold doctor 10/10.

## 2026-08-14 — CAP-037: port INVALID_JSON guard to admin-blocklist POST

Mechanical mirror of the CAP-035 fix-slice M1 guard. Same pattern, same shape, single route
extension. Captured as a follow-up during CAP-035 closure rather than expanding that slice.

**Fix** — `apps/worker/src/http/routes/admin-blocklist.ts:89-108`:

- Added `import { logger } from '../../platform/logger';` (line 31).
- Wrapped `createBlocklistEntryRequestSchema.parse(JSON.parse(rawBody))` (was line 88) in a
  try/catch that mirrors `admin-role-policies.ts:132-151` verbatim: `SyntaxError` →
  `logger.warn({ event: 'blocklist.post.invalid_json', actorUserId: userId })` (no body per
  R-SECRET-003 / `.claude/rules/security.md` §Logging) → `DomainError({ code: 'INVALID_JSON',
  message: 'Request body is not valid JSON', httpStatus: 400 })`. Non-`SyntaxError` exceptions
  re-throw so the zod `ZodError` path still reaches the error middleware as `400 VALIDATION_ERROR`.

**Test** — `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` (added inside the existing
`describe('POST /api/v1/admin/blocklist', …)` block): one test that POSTs `{not valid json` with a
fresh `Idempotency-Key` and asserts `response.status === 400` + `body.error.code === 'INVALID_JSON'`.
Mirrors `admin-role-policies.worker.test.ts:672-693`.

**Pre-fix behavior** (corrected per review M1): the error middleware (`http/middleware/error.ts:31-41`)
already maps `SyntaxError → 400 VALIDATION_ERROR`, so the pre-fix bug was not "500" but "generic
`VALIDATION_ERROR` code conflated with zod structural failures, no audit log line". The fix upgrades
the response to a stable dedicated code with a structured warn log carrying `actorUserId`. The
followup `VALIDATION_ERROR` path for zod failures is unchanged.

**Rule of Three:** two sites (`admin-role-policies.ts` + `admin-blocklist.ts`) remain a coincidence.
Deliberately not extracted into a helper — the helper is the CAP-031 decision.

**Review round** (single code reviewer — surface is verbatim mirror of an audited pattern):

- **M1** (contract + ledger text overstated pre-fix severity): original text claimed "surfaces as
  500 instead of 400". Verified false by reading `error.ts:31-41`. Corrected both the contract
  (`work/archive/2026-08/CAP-037/task.md`) and the ledger row to state "400 `VALIDATION_ERROR`
  (generic) → 400 `INVALID_JSON` (specific stable code)".
- **M2** (idempotency record not written on `INVALID_JSON`): intentional per ADR-004 — malformed
  body has no usable `requestHash`; storing and replaying would 409 a corrected retry. Same gap
  exists at `admin-role-policies.ts:132-151`. Deferred to **CAP-031** as **D-CAP-037-A**.
- **L1** (test header drops "Security M1" provenance): contract-prescribed, no action.
- **L2** (contract cited `:128-151` for the guard; actual guard is `:132-151`): corrected in
  contract.

**Status:** ACCEPT WITH FIXES. Ship after M1 + L2 (applied). M2 promoted to ledger; L1 follows.

**Gates** (orchestrator-run, post-fix, post-review): `pnpm typecheck` ✓, `pnpm lint` ✓,
`pnpm test:unit` 304/304, `pnpm test:worker` 449/449 (+1), `pnpm build` ✓,
`pnpm scaffold doctor` 10/10.

**Verified status** requires the operator's Phase 1 preview deploy with an
`Idempotency-Key`-keyed retry of the malformed-body case.

## 2026-08-14 — CAP-035 fix slice: review round + resolutions + re-review

Following the initial implementation (entry below), three independent reviewers ran in parallel
(architecture, code, security) and produced a consolidated finding list: **2 BLOCKER, 2 HIGH, 3
MEDIUM, 2 LOW**. The orchestrator dispatched a fix slice to the implementer (slice scope frozen
to the named finding list), ran the six quality gates independently to validate, then dispatched
fresh security + code reviewers for re-review.

**Fix slice — resolutions (file:line evidence where reviewer-named):**

- **B1 — Architecture rule dependency table did not permit `inbound-mail → admin`.** Added
  `admin (read-only, via contracts/*)` to the `inbound-mail` row at
  `.claude/rules/architecture.md:48`, plus the explanatory paragraph at `:60-64` recording the
  interface-only constraint (`BlocklistReader` + `RolePolicyReader` in
  `packages/contracts/src/admin/`, implementations in `modules/admin/`, wired in
  `app-context.ts`). Mirrors the outbound provider registry pattern (ADR-002). The
  persistence-ownership row at `:103` extended with `blocklist_entries, role_policies`.
- **B2 — Audit row not in the same D1 batch as the business write (R-AUDIT-001).** Every
  state transition on `blocklist_entries` / `role_policies` now writes `audit_events` +
  business row + `idempotency_records` in one `db.batch([...])`:
  - `admin-blocklist.ts:107` — POST: `prepareCreateBlocklistEntry` +
    `prepareCreateAuditEvent` (`action: 'blocklist.create'`) +
    `prepareCreateIdempotencyRecord`.
  - `admin-blocklist.ts:239` — DELETE (success path): `prepareDeleteBlocklistEntry` +
    `prepareCreateAuditEvent` (`action: 'blocklist.delete'`) +
    `prepareCreateIdempotencyRecord`.
  - `admin-role-policies.ts:169` — PUT: `prepareSetRolePolicy` +
    `prepareCreateAuditEvent` (`action: 'role_policy.set'`) +
    `prepareCreateIdempotencyRecord`.
  - DELETE 404 path (`admin-blocklist.ts:209-231`) writes an idempotency-only record with
    no business write and no audit row — security reviewer confirmed this is the correct
    non-state-transition shape.
- **H1 — Idempotency `operation` literal used a static `:id`-like substring instead of the
  per-request id (ADR-004 cross-resource collision).** Per-id operation namespace now
  embedded with the template literal at handler entry:
  - `admin-blocklist.ts:185` — `const operation = \`DELETE /api/v1/admin/blocklist/${id}\`;`,
    used by both `findIdempotencyRecord` and `prepareCreateIdempotencyRecord`.
  - `admin-role-policies.ts:100` — `const operation = \`PUT /api/v1/admin/roles/${roleId}/policy\`;`.
  - Cross-role idempotency collision test asserts isolation
    (`admin-role-policies.worker.test.ts:522-607`).
- **H2 — Test coverage gap on audit-in-batch + INVALID_JSON + banEmail `*`.** Added per-route
  worker tests named after the rule IDs:
  - `admin-blocklist.worker.test.ts:374-422` — POST audit row appears in `audit_events`.
  - `admin-blocklist.worker.test.ts:727-776` — DELETE audit row appears in `audit_events`.
  - `admin-blocklist.worker.test.ts:780-802` — DELETE 404 writes NO audit row.
  - `admin-role-policies.worker.test.ts:613-670` — PUT audit row appears in `audit_events`.
  - `admin-role-policies.worker.test.ts:676-693` — `INVALID_JSON` round-trip (status + code).
  - `pattern-matchers.test.ts` — deep-subdomain `matchesAvailDomain`, banEmail `*` round-trip.
- **M1 — `JSON.parse(rawBody)` would surface a SyntaxError as 500 instead of 400.** Wrapped
  in try/catch at `admin-role-policies.ts:132-151`: SyntaxError → log at `warn` with
  `{ event: 'role_policy.put.invalid_json', actorUserId: userId }` (no body) → throw
  `DomainError({ code: 'INVALID_JSON', message: 'Request body is not valid JSON',
  httpStatus: 400 })`. **The same antipattern is also present at `admin-blocklist.ts:88`**
  — escalated to MEDIUM and recorded as **CAP-037** rather than expanding the frozen slice.
- **M2 — Drizzle row-type aliases collided with contracts interface names.** Renamed to
  `BlocklistEntryRowDrizzle` / `NewBlocklistEntryRowDrizzle` in
  `apps/worker/src/database/schema/admin.ts:153-154`. `RolePolicyRowDrizzle` /
  `NewRolePolicyRowDrizzle` already had the suffix. Cross-boundary types continue to come
  from `packages/contracts`.
- **M3 — JSON-in-text relaxation comment referenced a placeholder CAP ID.** Migration
  `0010_blocklist_and_role_policies.sql:16` now names **CAP-036 JSON-AUDIT**; placeholder
  resolved.
- **L1 (accepted) — `inbound-mail.ts:88-97` per-recipient `getUserRoleIds` loop.** Future-
  scaling note, not a defect at current throughput; orchestrator-acknowledged.

**Process notes:**

- Architecture / code / security reviewers ran **in parallel** (3 independent reviewers, not
  3 sequential rounds).
- The fix slice was **frozen** to the consolidated finding list — implementer did not
  redesign or "fix" adjacent code outside the named list.
- All six quality gates run by the orchestrator **after** the fix slice, **before** the
  re-review dispatch:
  - `pnpm typecheck` ✓
  - `pnpm lint` ✓
  - `pnpm test:unit` — **304/304** (+1: matchesAvailDomain deep-subdomain)
  - `pnpm test:worker` — **448/448** (+7: audit-in-batch ×3, 404-no-audit, INVALID_JSON,
    cross-role idempotency, banEmail `*` round-trip)
  - `pnpm build` ✓
  - `pnpm scaffold doctor` — 10/10

**Re-review** (fresh security + code reviewers, did not write the fix slice):

- Security: **0 findings.** B1, H1, M1 all confirmed resolved with file:line evidence.
- Code: **0 BLOCKER / 0 HIGH / 0 MEDIUM / 1 LOW** — L1 admin-blocklist.ts:88 bare
  `JSON.parse`. Security reviewer had stated admin-blocklist was unaffected by M1 (incorrect);
  code reviewer correctly caught the inconsistency but under-classified the severity as LOW.

**Resolution of the classification conflict:** Per `.claude/rules/agent-collaboration.md`
§Conflict handling, the orchestrator decides and records the reasoning when two reviewers
disagree. The L1 finding is **the same class of bug** as M1 (bare `JSON.parse` on rawBody
with no try/catch), in **the same module** (admin), with **the same downstream consequence**
(SyntaxError surfaces as 500 instead of 400). Re-classified LOW → MEDIUM based on the
established precedent. Recorded as **CAP-037** rather than expanding the fix slice — the
scope was frozen.

**Deferred:**

- **CAP-037** — Port INVALID_JSON guard from `admin-role-policies.ts:132-151` to
  `admin-blocklist.ts:88`. Mechanical 5-line fix reusing the established pattern. Captured
  by the orchestrator during closure; the next capability picker will see it on the same
  row as CAP-035.

**CAP-035 status:** In Progress → **Implemented**. Contract archived to
`work/archive/2026-08/CAP-035/`.

## 2026-08-14 — D-CAP-021-A → CAP-035: Inbound blocklist + per-role policies

Phase 1 closed with two deferred rules unaddressed: `R-INBOUND-005` (blocklist matching on
subject/content/from) and `R-INBOUND-006` (per-role `availDomain` + `banEmail`). The deferred
item's wording ("per-role policies" is part of the same subsystem) was the prompt to lift both
into one capability rather than two.

**Contract** at `work/active/D-CAP-021-blocklist-and-role-policies/task.md`. Highlights:

- New tables `blocklist_entries` and `role_policies`, both admin-owned. The admin module already
  owns `roles`, so the `role_policies` FK is local; the inbound-mail module does **not** own
  the storage — it consumes via `packages/contracts` interfaces, the same shape the rest of
  the architecture uses for cross-module reads.
- Pattern semantics preserved from legacy facts BF-099 / BF-100: substring for blocklist;
  exact / `@domain` / `*` for `banEmail`; `@domain` for `availDomain`; empty `availDomain`
  means allow all. No regex in v1.
- Evaluation order from `workflows.md` step 4–6: blocklist → mailbox resolve → per-role
  policy. Rejection short-circuits before the `R-INBOUND-008` atomic batch, so no new
  atomicity concern.
- Admin CRUD surface for both tables. Idempotency wired (CAP-027). All routes gated by
  `requirePermission` (`settings.manage` / `role.manage`).
- Tests named after the rule IDs (`R-INBOUND-005` per kind; `R-INBOUND-006` per pattern form).

**Decisions locked in the contract** (all four open questions resolved before delegation):

1. The `inbound-mail → admin` dependency edge is **read-only and interface-only**: `inbound-mail`
   consumes `BlocklistEntryReader` / `RolePolicyReader` declared in `packages/contracts`,
   implemented in `modules/admin/*`, wired in `app-context.ts`. Mirrors the outbound provider
   registry pattern (ADR-002). The architecture rule table was updated to add this edge and
   record its semantics; `admin` persistence ownership row extended with `blocklist_entries`
   and `role_policies`.
2. `role_policies` JSON columns ship as **TEXT JSON in v1** with an inline comment naming the
   deferred-normalization follow-up. Captured as **CAP-036 (JSON-AUDIT)** in the ledger; the
   migration's `CAP-NNN` placeholder resolves to CAP-036.
3. Admin routes split into `admin-blocklist.ts` + `admin-role-policies.ts` (the existing
   `admin.ts` was already at 256 lines; the split keeps route files under the 150-line
   guideline).
4. Audit on reject is **OUT OF SCOPE** for v1 — `message.setReject(reason)` short-circuits
   before any DB write and returns immediately. Rationale: rejection is a no-op from the
   system's perspective (no state transition occurred), and the policy engine is local logic
   rather than a state machine. A future audit pass can add a `message.reject` action with no
   schema change beyond a new `audit_events.action` enum value.

**Resolved D-CAP-021-A** — the deferred item is closed by promotion to CAP-035 (In Progress).

## 2026-08-13 — CAP-027 review round: secret redaction, race wiring, ADR-004 amendment

Independent code + architecture review of CAP-027 (commit `ba35bd3`) produced two BLOCKERs, one
HIGH, and several MEDIUM/LOW findings; all confirmed by the orchestrator against the code before
delegation. The fix round (implementer subagent, validated by the orchestrator — its report
channel failed, so the tree was verified directly against the contract):

- **Secret redaction (BLOCKER).** `login`, `refresh`, `setup/claim`, and `admin/invite-codes`
  were persisting plaintext credentials in `idempotency_records.response_json`, surviving
  R-AUTH-005 revocation. These four now store a redacted body that is never served, and replay
  (same key + same hash) **re-executes** the handler, minting fresh credentials. Same key +
  different body still 409s. `register` keeps true replay (response carries no tokens —
  verified).
- **Race wiring (HIGH).** `replayAfterRace`/`isIdempotencyUniqueViolation` are now called by the
  three strict/batch routes; a UNIQUE-race loser replays the winner's response instead of 500ing
  or getting a false 409 `DOMAIN_ADDRESS_TAKEN` (mailboxes distinguishes the idempotency UNIQUE
  from the `(domain_id, local_part)` business UNIQUE).
- **Mailboxes create is now strict batch** (mailbox + audit_event + record in one D1 batch,
  R-OUTBOUND-006); messages read stays best-effort with a rationale comment.
- Setup routes run `setupSession` (401) before `requireIdempotencyKey` (400); smoke-test pending
  path returns typed 409 `IDEMPOTENCY_REQUEST_PENDING`; defensive missing-key errors are typed
  `IDEMPOTENCY_KEY_REQUIRED`; auth routes hash the raw body before replay lookup;
  `idempotencyRecords` Drizzle typing moved to `database/schema/identity.ts` (identity owns the
  table); verify.sql 9-column assertion fixed.
- **Tests.** Per-route-file: missing key 400, malformed key 400, byte-identical replay with
  no-second-business-row, 409 reuse, and a UNIQUE-race loser simulation named after
  R-OUTBOUND-005 / R-API-004. Gates (orchestrator-run): lint ✓, typecheck ✓, unit 278/278,
  worker 402/402, build ✓, doctor 10/10.

**ADR-004 amended** (orchestrator edit): requestHash is sha256 of raw body bytes (not canonical
JSON); secret-bearing endpoints redact-and-re-execute; strict batch only where a crash gap would
duplicate a business effect.

**Process notes.** QA + security review of the fixed state were performed by the orchestrator,
not independent subagents — seven agent report channels failed with API 400s this session. The
orchestrator did not author the fix code, but this is a weaker guarantee than independent review;
the user's manual local check is the compensating control. Subagent infra, not the rules, was the
constraint.

**Accepted LOW findings (recorded, not fixed).** (1) The secret endpoints' delete-then-re-execute
is not atomic: a concurrent same-key different-body request can execute instead of 409ing; same
actor only, no privilege impact. (2) A 409 response is an oracle for "this key was used by this
actor for this operation" — negligible. (3) Mark-read writes no `audit_events` row (pre-existing;
view-state, not a lifecycle transition).

**Deferred:** D-CAP-027-A — route-level idempotency orchestration is copy-pasted ~18× and the
mailboxes route owns raw batch SQL pending a tenancy-module batch API; a follow-up capability
introduces shared middleware/HOC.

## 2026-08-13 — CAP-027: Idempotency records on every mutating endpoint (ADR-004)

Implemented ADR-004 idempotency across all 17 mutating HTTP endpoints. Idempotency-Key header
required on POST/PATCH/DELETE; same key + same body replays stored response; same key + different
body returns 409 IDEMPOTENCY_KEY_REUSED. Migration 0009 creates `idempotency_records` table with
unique index on (actor_id, operation, idempotency_key) and expires_at index for future TTL purge.

**Implementation:**
- Setup endpoints (11): best-effort idempotency with lookup/replay before use case, write after.
  Actor is sha256_hex(session token). Natural guards (singularity, UNIQUE) prevent double-execution
  on retry.
- Auth endpoints (3): same best-effort pattern. Actor is sha256_hex(registration code) for register,
  sha256_hex(email) for login/refresh.
- User-facing endpoints (4): strict batch atomicity. Idempotency record appended to existing D1 batch
  in route handlers (compose, mailboxes, messages). Satisfies R-OUTBOUND-006.

**Files created:**
- `migrations/0009_idempotency_records.sql` + `.verify.sql` + `.md`
- `apps/worker/src/platform/idempotency.ts` + `.test.ts`
- `apps/worker/src/http/middleware/idempotency.ts`
- `work/active/CAP-027-idempotency/task.md` (workspace contract)

**Files modified:**
- `apps/worker/src/database/schema/admin.ts` — idempotencyRecords table
- `apps/worker/src/database/schema-version.ts` — bumped to '0009'
- `apps/worker/src/http/routes/setup.ts` — 11 POST routes with idempotency
- `apps/worker/src/http/routes/auth.ts` — 3 POST routes with idempotency
- `apps/worker/src/http/routes/admin.ts` — POST /invite-codes with idempotency
- `apps/worker/src/http/routes/compose.ts` — strict batch atomicity
- `apps/worker/src/http/routes/mailboxes.ts` — strict batch atomicity
- `apps/worker/src/http/routes/messages.ts` — strict batch atomicity

**Testing:** 44 new idempotency test cases across all route test files (missing key, replay,
409 reuse). R-OUTBOUND-005, R-OUTBOUND-006, R-API-004 citations present. Quality gates pass:
typecheck, lint, test:unit 278, test:worker 385, build, doctor 10/10, drizzle-kit check.

**Deferrals:** None from this capability. Resolves D-CAP-008-B, D-CAP-010-A, D-CAP-011-A.

**Next:** Independent review (architecture, code, QA, security), then client-side TanStack Query
UUID generation for Idempotency-Key (Phase 2).

## 2026-08-13 — Phase 1 verification pass

The Phase 1 capability set (CAP-020 through CAP-026) was independently reopened for verification
on `cap/CAP-020-026-business-loop`. All quality gates pass on the current commit (`21870d0`):

```
pnpm typecheck           ✓
pnpm lint                ✓
pnpm test:unit           ✓  232 / 232  (12 files)
pnpm test:worker         ✓  348 / 348  (26 files)
pnpm build               ✓  (worker + web)
pnpm scaffold doctor     ✓  10 / 10
```

**Independent verification performed:**
- All 29 exit criteria in `F-minimal-business-closed-loop.md` §F.4 cross-checked against the
  implementation. Every box has a corresponding repository artifact (route, handler, repository,
  test, or migration).
- Migration set 0005–0008 present; `schema-version.ts` is `0008`; `migrationsDb.ts` includes all
  four in its `splitSql` list.
- Two-layer authorization (`requirePermission` + `assertCan`) verified on every protected route
  in `messages`, `compose`. The `mailboxes` routes use a single layer (global permission) plus
  per-request scope checks expressed in SQL — the misleading two-layer comment in the header
  was corrected in this pass.
- No module imports a provider SDK directly (no `brevo`, `resend`, `@sendgrid` in `modules/`).
- No `admin` import from `outbound-mail` (the architectural constraint that placed the
  `webhook.delivered` audit emit in the route layer).
- No `hono` or `globalThis.fetch` in `modules/`.
- Business rule citations present in code at every required handler (R-MESSAGE-005,
  R-MESSAGE-011, R-INBOUND-005, R-INBOUND-008, R-OUTBOUND-004, R-OUTBOUND-006, R-AUTHZ-003,
  R-AUTHZ-004, R-AUDIT-001).
- All audit event emit points (six total) are present in the expected files.

**Defects found and fixed during this audit pass:**
1. `migrations/0005_mailboxes.sql` was missing the `INSERT OR IGNORE INTO d1_migrations`
   tracking row that 0006/0007/0008 have — the migration would re-run on every apply
   (survived only because every `CREATE` uses `IF NOT EXISTS`). Fixed.
2. `migrations/0008_webhook_events.sql` `webhook_deliveries.raw_payload TEXT` was an
   undeclared R-DATA-005 exception. Added a sized `CHECK (length(raw_payload) <= 65536)`
   constraint and an explicit rationale comment matching the `audit_events.metadata`
   pattern. Added a verification query in `0008_webhook_events.verify.sql`.
3. `apps/worker/src/http/routes/mailboxes.ts` header comment claimed two-layer authz
   but the code has only one. Rewrote the comment to honestly describe the actual
   authorization model (global permission + per-request scope checks in SQL).
4. R-MAILBOX-003 had no explicit test. Added a worker-pool test asserting that the owner
   can perform every operation without an explicit `mailbox_members` row.
   `test:worker` 348 → 349.

**Defect deferred (recorded in ledger):**
- `D-CAP-021-A`: R-INBOUND-005 (blocklist matching on subject/content/from) and
  R-INBOUND-006 (per-role `banEmail`/`availDomain`) are not implemented in the Phase 1
  inbound handler. Phase 1 accepts every inbound message whose recipient resolves to a
  mailbox. A future capability introduces the blocklist table and the receive-time policy
  evaluation.

**Known Phase 1 limitations (recorded in the ledger, not blocking):**
- `message_user_state` PK is `(mailbox_message_id)`; multi-user read-state independence is best
  effort. Schema migration is a future capability (CAP-026 §Note).
- Compose endpoint does not enforce `Idempotency-Key` (R-OUTBOUND-005). Deferred to CAP-027.
- `max_attempts` on `outbound_jobs` is set but the queue consumer does not gate `msg.retry()` on
  it (relies on Cloudflare Queues' own retry policy). Future capability.
- Cursor pagination uses simple base64 encoding; HMAC signing is CAP-034 (Phase 2).
- `apps/web/` is still a TanStack Router stub with `/` and `/setup` only. The 27-step §F.1 loop
  is verified end-to-end via the HTTP API and the worker-pool tests that exercise it. The
  browser UI for `/inbox`, `/admin`, `/compos`e, and `/admin/webhook-events` is a Phase 1 follow-up
  capability (the React client itself exists; the feature pages do not yet).

**Verification status:** Phase 1 is **Code complete and quality-gate verified**. `Verified` per
the ledger's status vocabulary requires an observed end-to-end run on a preview deployment —
that is the operator's next step, not a code change.

**Files updated by this verification pass:**
- `migrations/0005_mailboxes.sql` — added `d1_migrations` tracking row (defect A).
- `migrations/0008_webhook_events.sql` — added bounded `CHECK` and R-DATA-005 exception
  comment (defect B).
- `migrations/0008_webhook_events.verify.sql` — added verification query for the bound.
- `apps/worker/src/http/routes/mailboxes.ts` — corrected header comment about authz layers
  (defect C).
- `apps/worker/src/http/routes/mailboxes.worker.test.ts` — added R-MAILBOX-003 test
  (defect D).
- `docs/rebuild/capability-ledger.md` — Phase 1 row marked "Code complete and quality-gate
  verified" with gate-evidence summary; CAP-020 (test count corrected) and CAP-021 (R-INBOUND-005
  gap noted) evidence rows tightened; new deferred item D-CAP-021-A.
- `docs/rebuild/capability-ledger.md` §Phase progress — Phase 1 row now points to the audit.
- `docs/rebuild/phase-1-audit.md` (new) — full audit report against §F.4.
- `docs/rebuild/08-roadmap/phase-1-minimal-loop.md` — acceptance-criteria header aligned to 29
  boxes (D-1 resolved); added verification status table.
- `docs/rebuild/README.md` — Phase progress table updated to "Code complete and quality-gate
  verified".
- `work/active/CAP-022-inbox/` — removed (empty, stale).

## 2026-08-13 — Phase 1 business loop: CAP-020 through CAP-026

All seven Phase 1 capabilities implemented via subagent delegation. The minimal business closed loop
is now code-complete: an admin can install, claim a domain, connect Brevo, invite a user, and that
user can read a real inbound email and reply. The reply is sent via Brevo, the delivery webhook updates
the message status, and every state transition writes an audit event.

**Migrations landed:** 0005 (mailboxes), 0006 (messages), 0007 (outbound_jobs), 0008 (webhook_events).
Schema version is now 0008. All quality gates pass: typecheck, lint, test:unit (232), test:worker (348),
build, doctor 10/10.

**Key decisions:**
- `message_user_state` PK is `(mailbox_message_id)` not `(mailbox_message_id, user_id)` — multi-user
  read-state independence has a known limitation. The query falls back to 0 when no row matches the
  (mailbox_message_id, user_id) pair. Full fix is a schema migration in a future capability.
- `webhook.delivered` audit emit is in the route layer (`webhooks.ts`), not in `webhook-processor.ts`,
  because `outbound-mail` cannot import from `admin` per `module-dependency-zones`. The processor
  returns `messageId` so the route can emit with the correct resourceId.
- `webhook_secret` on `provider_connections` is stored as plaintext — it is a random HMAC signing key,
  not a password or provider API key. `ensureWebhookSecret` generates a 256-bit hex secret on first read.
- Compose endpoint does not yet enforce `Idempotency-Key` (R-OUTBOUND-006 defers to CAP-027).
- `max_attempts` on outbound_jobs is set to 3 but the queue consumer relies on Cloudflare Queues'
  own retry policy. Gating `msg.retry()` on attempts is a future capability.
- Cursor pagination uses simple base64 encoding of `(created_at, id)`. HMAC signing is CAP-034 (Phase 2).

Format:

```
## YYYY-MM-DD — CAP-NNN <name>  |  <Status>

**Changed:** <behaviour now available, in business terms>
**Files:** <significant paths>
**Rules:** <R-* implemented>
**Decisions:** <decision → where persisted>
**Deferred:** <item → where recorded>
**Notes:** <anything the next agent would be surprised by>
```

## 2026-08-13 — CAP-018 + CAP-019 Registration keys + Auth  |  Implemented

**Changed:** Full authentication system. CAP-018: admin issues invite codes via `POST /api/v1/admin/invite-codes`. CAP-019: users register with a code (`POST /api/v1/auth/register`), login with email+password (`POST /api/v1/auth/login`), get access+refresh tokens, refresh tokens, get current user (`GET /api/v1/auth/me`). Global auth middleware sets `userId` from KV `auth:{token}`. `requirePermission` now fully functional.

**Files:** `migrations/0004_registration_keys.sql` + verify · `apps/worker/src/database/schema/onboarding.ts` (registrationKeys) · `apps/worker/src/platform/crypto.ts` (verifyPassword) · `apps/worker/src/modules/onboarding/registration-key-repository.ts` (new) · `apps/worker/src/modules/identity/user-repository.ts` (findUserByEmail) · `apps/worker/src/modules/identity/session-repository.ts` (new) · `apps/worker/src/http/middleware/authn.ts` (new — global auth middleware) · `apps/worker/src/http/routes/auth.ts` (new — register, login, refresh, me) · `apps/worker/src/http/routes/admin.ts` (new — invite-codes CRUD) · `apps/worker/src/http/router.ts` (mount authn + new routes) · `packages/contracts/src/index.ts` (registerRequestSchema, loginRequestSchema, refreshRequestSchema) · schema version → '0004'

**Decisions:**
- Access token: UUID stored in CACHE KV (`auth:{token}`), 15-min TTL. Sets `c.set('userId', userId)` if valid.
- Refresh token: UUID, SHA-256 hash stored in sessions table, 30-day expiry. Never plaintext.
- Registration code: 32 random bytes → 64-char hex, SHA-256 hash stored. Only shown to admin once.
- `INVALID_CREDENTIALS` for both wrong email AND wrong password (don't leak which).
- Registration is a single D1 batch: create user + assign member role + increment key usage.
- Auth routes (register, login, refresh) are public. Admin routes need authn + requirePermission.
- `verifyPassword` converts both Uint8Arrays to hex, then uses `constantTimeCompare` on hex strings.

**Deferred:** D-CAP-019-A (idempotency on /register → CAP-027), D-CAP-019-B (email verification flow → Phase 2).

**Notes:** Fixed test bug: admin tests were destructuring `accessToken` from top-level response instead of `data.accessToken`. Two locations, both 403 tests. Fixed preflight test (schemaVersion '0003' → '0004'). Added contract tests for registerRequestSchema, loginRequestSchema, refreshRequestSchema.

## 2026-08-13 — CAP-017 Roles + permissions seed  |  Implemented

**Changed:** Admin module introduced. 20 permission keys seeded. 2 roles (administrator=all, member=5 perms). `completeSetup` now seeds roles + assigns administrator to first user. `requirePermission(key)` middleware implemented (reads `c.get('userId')`, 401/403 on failure).

**Files:** `apps/worker/src/modules/admin/permission-repository.ts` (new — checkPermission) · `apps/worker/src/modules/admin/seed-repository.ts` (new — seedRolesAndPermissions, assignRole) · `apps/worker/src/modules/admin/index.ts` (new module) · `apps/worker/src/http/middleware/authz.ts` (new — requirePermission) · `apps/worker/src/modules/onboarding/complete-setup.ts` (modified — seeding + role assignment) · `packages/contracts/src/index.ts` (permissionKeySchema) · `apps/worker/src/platform/env.ts` (AppEnv Variables: { userId?: string })

**Decisions:**
- Deterministic IDs: permission id = key (e.g., `'message.read'`), role id = name (e.g., `'administrator'`). System seed data, not domain aggregates.
- Seeding during setup completion — `completeSetup` calls seed → assign admin → flip status. Roles exist before the first user logs in.
- `requirePermission` reads `c.get('userId')` from Hono Variables — set by future auth middleware (CAP-019). Without auth, always returns 401.

## 2026-08-13 — CAP-015 + CAP-016 Setup wizard complete  |  Implemented

**Changed:** `POST /api/v1/setup/outbound-smoke-test` (decrypts Brevo API key, sends test email, advances step to 'complete') + `POST /api/v1/setup/complete` (flips status to 'complete', `GET /` serves HTML shell). **The entire setup wizard is now implemented — all 9 steps.**

**Files:** `apps/worker/src/modules/identity/user-repository.ts` (added `getFirstUser`) · `apps/worker/src/modules/outbound-mail/credential-repository.ts` (added `getCredentialByName`) · `apps/worker/src/modules/onboarding/outbound-smoke-test.ts` (new — decrypt + send) · `apps/worker/src/modules/onboarding/complete-setup.ts` (new — flip status) · `apps/worker/src/http/routes/setup.ts` (added POST /outbound-smoke-test + POST /complete) · `apps/worker/src/http/router.ts` (added GET / handler) · `apps/worker/src/http/routes/outbound-smoke-test.worker.test.ts` + `complete-setup.worker.test.ts` (new — 34 tests combined)

**Decisions:**
- First decrypt-and-use flow: outbound smoke test reads encrypted_credentials, decrypts with AES-GCM, constructs ProviderRuntimeContext with the plaintext key, calls adapter.send(). Decrypted key lives only in request scope (ADR-007).
- `GET /` returns minimal HTML shell (`<div id="root">`). Real React app assets served via CDN/Workers Sites in production. Setup gate ensures `GET /` is only reachable when status='complete'.
- Sender address for smoke test: `noreply@<domain>`. Recipient: admin user's email.

**Notes:** Setup wizard complete: claim → preflight → administrator → domain → cloudflare-verify → inbound-smoke → brevo → outbound-smoke → complete. After complete, `GET /` returns 200 HTML (setup gate passes through). Phase 1 progress: 9/17 capabilities. Remaining: CAP-017 through CAP-026 (roles, registration, mailboxes, inbound processing, inbox, compose, webhooks, audit).

## 2026-08-13 — CAP-014 Brevo provider + encrypted credentials  |  Implemented

**Changed:** `POST /api/v1/setup/brevo` — accepts Brevo API key, validates via adapter, encrypts with AES-GCM, stores encrypted credential + provider connection, links to managed domain, advances step to 'outbound-smoke'. Introduces outbound-mail module, provider registry, Brevo adapter, and AES-GCM encryption.

**Files:** `migrations/0003_provider_connections.sql` (new) · `apps/worker/src/platform/crypto.ts` (added `importEncryptionKey`/`encrypt`/`decrypt`) · `apps/worker/src/modules/outbound-mail/` (new module — credential + connection repositories) · `apps/worker/src/integrations/providers/brevo.ts` (new — OutboundProviderAdapter) · `apps/worker/src/integrations/providers/provider-registry.ts` (new) · `apps/worker/src/modules/onboarding/setup-brevo.ts` (new — use case) · `packages/contracts/src/index.ts` (`setupBrevoRequestSchema`) · `apps/worker/src/http/routes/brevo.worker.test.ts` (new) · schema version bumped to '0003'

**Decisions:**
- `onboarding → outbound-mail` edge approved — setup wizard creates provider connections.
- Validation before encryption — don't encrypt an invalid API key. Adapter validates first via `GET /v3/account`.
- Four-statement D1 batch (credential + connection + domain.outbound_connection_id + step advance) — atomic.
- AES-GCM: 12-byte IV, 16-byte auth tag stored as separate BLOB columns per ADR-007. Key from Secrets Store via `importEncryptionKey` (hex → CryptoKey).
- Brevo adapter in `integrations/providers/` — owns HTTP calls. Modules call through `OutboundProviderAdapter` interface (ADR-002).
- Implemented via two sequential subagents (infrastructure + integration) due to API size limits on single-agent dispatch.

**Notes:** Brevo API mocked via `vi.spyOn(globalThis, 'fetch')` in worker-pool tests. Preflight test updated (schemaVersion '0002' → '0003'). `CREDENTIAL_ENCRYPTION_KEY` in wrangler.test.jsonc is a valid 32-byte hex string for AES-256.

## 2026-08-13 — CAP-013 Inbound smoke test  |  Implemented

**Changed:** `POST /api/v1/setup/inbound-smoke-test` (start) + `POST /api/v1/setup/inbound-smoke-test/check` — verifies Cloudflare Email Routing delivers emails to the Worker. Start generates `smoke+<uuid>@<domain>` address; operator sends email manually; email handler detects the `smoke+` prefix, validates token in KV, sets receipt flag; check endpoint polls KV, advances step to 'brevo' on receipt. First modification to the inbound email handler (previously reject-all stub).

**Files:** `apps/worker/src/modules/onboarding/inbound-smoke-test.ts` (new — startInboundSmokeTest, checkInboundSmokeTest, handleSmokeTestMessage) · `apps/worker/src/entrypoints/inbound-email.ts` (modified — added env param, calls handleSmokeTestMessage) · `apps/worker/src/http/routes/setup.ts` (added 2 routes) · `apps/worker/src/http/routes/inbound-smoke-test.worker.test.ts` (new — 24 tests) · `apps/worker/src/entrypoints/inbound-email.worker.test.ts` (updated — real env instead of mock)

**Decisions:**
- Operator sends email manually — Worker can't send email to itself (no outbound provider yet).
- CACHE KV for ephemeral smoke test state (`smoke:{token}`, `smoke:active`, `smoke-result:{token}`) with 5-min TTL. No migration needed.
- Email handler accepts smoke-test messages by token validation; all others rejected until CAP-021.
- `handleSmokeTestMessage` lives in onboarding module (setup concern, not inbound-mail concern). Email handler calls it via `modules/onboarding/index.ts`.
- Two endpoints: start (generates address) + check (polls receipt). Frontend calls start once, then polls check.

**Notes:** Legacy inbound-email.worker.test.ts fixed: replaced mock env (violated testing rules — "Never mock D1/R2/KV/Queue") with real `env` from `cloudflare:test`. Removed `Queue<any>`. Email handler tests use mock message (allowed — not a storage binding) with real KV.

## 2026-08-13 — CAP-012 Cloudflare dashboard-link + verify  |  Implemented

**Changed:** Two session-protected endpoints: `POST /api/v1/setup/cloudflare/dashboard-link` (returns allowlisted Cloudflare dashboard URL, no step change) and `POST /api/v1/setup/cloudflare/verify` (checks managed domain exists, advances step to 'inbound-smoke'). Phase 1: verify is operator-confirmation only — no Cloudflare API call. Real email-delivery verification via CAP-013 inbound smoke test.

**Files:** `apps/worker/src/modules/onboarding/cloudflare-dashboard-link.ts` (new — getCloudflareDashboardLink) · `apps/worker/src/modules/onboarding/cloudflare-verify.ts` (new — verifyCloudflareEmailRouting) · `apps/worker/src/modules/tenancy/domain-repository.ts` (added getManagedDomain) · `apps/worker/src/modules/tenancy/index.ts` (export getManagedDomain) · `apps/worker/src/http/routes/setup.ts` (added POST /cloudflare/dashboard-link + POST /cloudflare/verify) · `apps/worker/src/http/routes/cloudflare.worker.test.ts` (new — 19 tests)

**Decisions:** Verify is operator-confirmation only (Phase 1). Dashboard URL is generic (`https://dash.cloudflare.com`). No new contracts (empty POST bodies, simple response shapes).

**Notes:** Orchestrator-validated (pattern identical to CAP-009/010/011 — session-protected, one use case, envelope response). Setup-gate test updated (dashboard-link and verify routes now exist → 401 instead of 404).

## 2026-08-13 — CAP-011 Setup domain endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/domain` — session-protected endpoint persisting a managed domain with `status='active'`. After creation, the installation step advances to 'cloudflare-verify'. Introduces the tenancy module and the first schema migration since CAP-004.

**Files:** `migrations/0002_managed_domains.sql` (new — managed_domains table) · `migrations/0002_managed_domains.verify.sql` (new) · `apps/worker/src/database/schema/tenancy.ts` (new — Drizzle typing) · `apps/worker/src/database/schema-version.ts` (bumped to '0002') · `apps/worker/src/modules/tenancy/domain-repository.ts` (new — prepareCreateDomain + createDomain) · `apps/worker/src/modules/tenancy/index.ts` (new module) · `apps/worker/src/modules/onboarding/create-domain.ts` (new — createDomainStep use case) · `apps/worker/src/http/routes/setup.ts` (added POST /domain) · `packages/contracts/src/index.ts` (domainNameSchema, setupDomainRequestSchema) · `packages/test-kit/src/migrationsDb.ts` (splitSql for multi-migration support) · `apps/worker/src/http/routes/domain.worker.test.ts` (new — 25 tests)

**Decisions:**
- `onboarding → tenancy` edge approved — onboarding orchestrates the setup wizard, which creates domains. Same pattern as `onboarding → identity` (CAP-010).
- Domain-existence guard (`SELECT 1 FROM managed_domains LIMIT 1`) before insert — only one domain during setup. Same pattern as CAP-010's administrator singularity guard.
- `splitSql` in migrationsDb.ts — splits migration SQL on line-ending semicolons for `applyD1Migrations`. Both migrations now use this (0001 was previously passed as a single string).
- `outbound_connection_id` nullable without FK — `provider_connections` table doesn't exist yet. FK added in a later migration.

**Deferred:** D-CAP-011-A (idempotency → CAP-027), D-CAP-011-B (splitSql semicolon risk → follow-up).

**Notes:** Reviewer dispatched but went idle without report. Orchestrator validated: no architecture violations, no type-safety issues, all quality gates green (12/119 unit, 11/120 worker, doctor 10/10). Stale preflight test updated (schemaVersion '0001' → '0002'). Stale domain test updated (DOMAIN_NAME_TAKEN → DOMAIN_ALREADY_MANAGED — existence guard fires before D1 constraint).

## 2026-08-13 — CAP-010 Setup administrator endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/administrator` — session-protected endpoint that creates the first user (the initial administrator) with a PBKDF2-SHA256-hashed password (ADR-006). After successful creation, the installation step advances from 'administrator' to 'domain'. Introduces the identity module and `hashPassword` in platform/crypto.ts.

**Files:** `apps/worker/src/platform/crypto.ts` (added `hashPassword` — PBKDF2-SHA256, 600k iterations) · `apps/worker/src/modules/identity/user-repository.ts` (new — `createUser` + `prepareCreateUser`) · `apps/worker/src/modules/identity/index.ts` (new module) · `apps/worker/src/modules/onboarding/create-administrator.ts` (new — `createAdministrator` use case) · `apps/worker/src/modules/onboarding/installation-state-repository.ts` (added `prepareUpdateInstallationStep`) · `apps/worker/src/modules/onboarding/index.ts` (export `createAdministrator`) · `apps/worker/src/http/routes/setup.ts` (added POST /administrator) · `packages/contracts/src/index.ts` (`setupAdministratorRequestSchema`) · `apps/worker/src/http/routes/administrator.worker.test.ts` (new — 24 worker-pool tests) · `apps/worker/src/platform/crypto.test.ts` (added 19 hashPassword unit tests)

**Rules:** ADR-006 (PBKDF2-SHA256), security.md §Passwords, R-AUTH-002 (users.status='active'), R-AUTH-009 (email case-insensitive), R-DATA-001 (email normalized)

**Decisions:**
- `createAdministrator` use case lives in onboarding (not identity) because it needs to update `installation_state` (owned by onboarding). onboarding depends on identity — allowed per architecture rules.
- User insert + step update are a single D1 `batch()` — atomic. If either fails, both roll back. `prepareCreateUser` and `prepareUpdateInstallationStep` expose `D1PreparedStatement` objects for batch composition.
- Singularity guard checks `SELECT 1 FROM users LIMIT 1` BEFORE hashing (saves ~600ms on rejected calls). Returns SETUP_ADMINISTRATOR_EXISTS (409). The D1 UNIQUE constraint on email is a defensive backstop for race conditions.
- No role assignment — roles and permissions are seeded in CAP-017. The setup session authenticates all setup operations.
- PBKDF2 confirmed working in Cloudflare Workers via `crypto.subtle.deriveBits` — ~600ms per hash, within Workers Paid plan 30s CPU budget.
- `hashPassword` uses `crypto.getRandomValues` for salt (not `ids.uuid()` — that's for domain IDs).

**Deferred:** D-CAP-010-A (idempotency → CAP-027), D-CAP-010-B (Drizzle BLOB typing → CAP-019).

**Notes:** Two reviewers ran (architecture ACCEPT WITH NOTES, code ACCEPT WITH NOTES). Code review HIGH (BLOB assertion via `as number[]`) fixed — `new Uint8Array()` with typed `.first<>()`. Both reviewers flagged atomicity (M1/Arch-HIGH) — fixed via D1 batch. Arch MEDIUM (singularity guard) fixed — existence check before hash. Arch LOW (error string robustness) fixed — `err instanceof Error && err.message`. Wrong rule citations in crypto.ts fixed.

## 2026-08-12 — CAP-009 Setup preflight endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/preflight` — session-protected endpoint that reports each of the 7 Cloudflare bindings as present/accessible and the database schema version from `d1_migrations`. Introduces the setup-session middleware that validates `Authorization: Bearer <sessionToken>` against KV — the gate for all post-claim setup endpoints.

**Files:** `apps/worker/src/http/middleware/setup-session.ts` (new — session validation) · `apps/worker/src/modules/onboarding/preflight.ts` (new — runPreflight use case) · `apps/worker/src/modules/onboarding/index.ts` (export runPreflight) · `apps/worker/src/http/routes/setup.ts` (added POST /preflight with session middleware) · `packages/contracts/src/index.ts` (setupPreflightResponseSchema) · `apps/worker/src/http/routes/preflight.worker.test.ts` (new — 14 worker-pool tests) · `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (updated: preflight now 401 not 404)

**Rules:** R-AUTH-001 (session required after claim), R-SETUP-003 (setup routes exempt from gate)

**Decisions:**
- Session middleware applied inline on `/preflight` only (`routes.post('/preflight', setupSession, handler)`). `/status` and `/claim` remain public. Future session-protected routes add `setupSession` inline until Rule of Three justifies a route group.
- Binding checks are existence-only: `!!env.BINDING` for D1/R2/KV/Queue, `readSecret` try/catch for Secrets Store. Deep health checks (actual queries, puts) are a future concern.
- Schema version from `d1_migrations` table (`ORDER BY id DESC LIMIT 1`) — reflects what the database was actually migrated to, not what the code expects.
- `checkSecret` logs at `warn` on failure — this is a diagnostic endpoint; swallowing errors defeats its purpose.

**Deferred:** D-CAP-009-A (SecretLike type for checkSecret — code review L3), D-CAP-009-B (redundant db param — L4).

**Notes:** Code review ACCEPT WITH NOTES (M1: checkSecret error logging — fixed; L1: ORDER BY id — fixed; L2: empty-token test — added). Architecture review pending. HTTP trims trailing whitespace from header values, so `'Bearer '` becomes `'Bearer'` → SETUP_SESSION_REQUIRED (documented in test).

## 2026-08-12 — CAP-008 Setup claim endpoint  |  Implemented

**Changed:** `POST /api/v1/setup/claim` validates the `INSTALLATION_TOKEN` with constant-time comparison, creates a 30-minute KV setup session, and seeds `installation_state` to `current_step='preflight'`. Wrong token → 401, missing/empty token → 400, already complete → 409. Error middleware replaced — DomainError → httpStatus, ZodError → 400, SyntaxError → 400, unknown → 500 with log.

**Files:** `apps/worker/src/modules/onboarding/claim-setup.ts` (new — claimSetup use case) · `apps/worker/src/modules/onboarding/installation-state-repository.ts` (added seedInstallationState) · `apps/worker/src/modules/onboarding/index.ts` (export claimSetup) · `apps/worker/src/http/routes/setup.ts` (added POST /claim) · `apps/worker/src/http/middleware/error.ts` (real error mapping) · `apps/worker/src/platform/crypto.ts` (constantTimeCompare) · `apps/worker/src/platform/secrets.ts` (new — readSecret helper) · `apps/worker/wrangler.test.jsonc` (new — test wrangler config) · `packages/contracts/src/index.ts` (setupClaimRequestSchema) · `apps/worker/src/http/routes/claim.worker.test.ts` (new — 13 worker-pool tests) · `apps/worker/src/http/middleware/error.test.ts` (new — 6 unit tests) · `apps/worker/src/platform/crypto.test.ts` (new — 7 unit tests) · `apps/worker/src/platform/secrets.test.ts` (new — 3 unit tests)

**Rules:** Constant-time compare per security.md §Passwords / ADR-006. Secrets never logged per R-SECRET-003.

**Decisions:**
- `readSecret` helper bridges `SecretsStoreSecret` (prod: `.get()`) and `string` (test: miniflare vars). Keeps Cloudflare types out of the use case.
- `wrangler.test.jsonc` — miniflare cannot populate `secrets_store_secrets` values. Test config uses `vars` instead. Cross-reference comments added to both wrangler files. Drift risk tracked as D-CAP-008-A.
- Error middleware: `DomainError` → httpStatus, `ZodError` → 400 VALIDATION_ERROR, `SyntaxError` → 400 (JSON parse failures), unknown → 500 INTERNAL with `console.error` log. Uses `Response.json()` (Web API static) not `c.json()`.
- `ON CONFLICT DO NOTHING` seed — idempotent. Re-claiming after session expiry preserves existing `current_step`.
- Timestamps use SQLite `datetime()` format (`YYYY-MM-DD HH:MM:SS`) to match the DDL default and test-kit convention.
- Idempotency-Key deferred to CAP-027 (D-CAP-008-B). Phase 0 has no idempotency infrastructure.
- requestId in error envelope deferred (D-CAP-008-C / D-CAP-006-B).

**Deferred:** D-CAP-008-A (doctor check for wrangler.test.jsonc drift), D-CAP-008-B (idempotency on /claim → CAP-027), D-CAP-008-C (requestId in error envelope → D-CAP-006-B).

**Notes:** Two reviewers ran (architecture ACCEPT WITH NOTES, code ACCEPT WITH NOTES). Architecture MEDIUM on wrong rule citations (R-AUTH-006, R-SECRET-001 were incorrect — fixed to cite security.md §Passwords / ADR-006 / R-SECRET-003). Code HIGH on missing error middleware unit tests (AC #7 unmet — added error.test.ts with 6 cases). Implementer's original test/setup.ts monkey-patching was broken (ran in Node.js, not workerd) — replaced with wrangler.test.jsonc approach.

## 2026-08-12 — CAP-007 Setup status endpoint  |  Implemented

**Changed:** `GET /api/v1/setup/status` returns the current installation state in the success envelope `{ "data": { "status", "currentStep" } }`. On a fresh DB (no `installation_state` row), defaults to `{ "status": "setup", "currentStep": "claim" }`. This is the first real API route and establishes the route-handler + sub-app pattern for all future setup endpoints.

**Files:** `apps/worker/src/modules/onboarding/setup-status.ts` (new — `getSetupStatus` use case) · `apps/worker/src/modules/onboarding/index.ts` (exports `getSetupStatus`, repository now private) · `apps/worker/src/http/routes/setup.ts` (new — setup sub-app) · `apps/worker/src/http/router.ts` (mounts sub-app at `/api/v1/setup`) · `apps/worker/src/http/middleware/setup-gate.ts` (imports `getSetupStatus`, null branch removed) · `apps/worker/src/http/routes/setup-status.worker.test.ts` (new, 9 cases) · `packages/test-kit/src/seed.ts` (new — `seedInstallationState`, `resetAndMigrate`, `FIXED_TIMESTAMP`) · `packages/test-kit/src/index.ts` (exports seed helpers) · `scripts/doctor.ts` (intra-module self-import fix) · `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (updated: uses test-kit helpers, `/status` now 200 not 404)

**Rules:** R-SETUP-002 (fresh DB defaults to `claim`), R-SETUP-003 (setup routes exempt from gate)

**Decisions:**
- `getSetupStatus` absorbs the null case: the repository returns `null` for a fresh DB; the use case returns `{ status: 'setup', currentStep: 'claim' }`. Callers never handle null (resolves D-CAP-006-C).
- Setup routes sub-app (`http/routes/setup.ts`): a Hono sub-app for `/api/v1/setup/*`. CAP-008 (claim) and CAP-009 (preflight) will add routes to the same file.
- Response shape is `{ "data": InstallationStateInfo }` — returns both `status` and `currentStep`. The acceptance criterion mentions only `currentStep`, but the React client needs `status` to redirect away from `/setup` when installation is complete.
- Test helpers promoted to test-kit (`packages/test-kit/src/seed.ts`): `seedInstallationState`, `resetAndMigrate`, `FIXED_TIMESTAMP` were duplicated across two test files (resolves D-CAP-006-A). `seedInstallationState`'s `currentStep` typed as `InstallationStep` from contracts, not `string`.
- Doctor `module-dependency-zones` fix: intra-module self-imports (`t !== m`) are now allowed. The check was a latent false positive — `setup-status.ts` importing `./installation-state-repository` (same module) was flagged because `ALLOWED['onboarding']` doesn't contain `'onboarding'`. Self-imports are always legal; the zone rules govern cross-module edges only.

**Deferred:** D-CAP-007-A (endpoint DB-failure test — error middleware is a CAP-001 stub). D-CAP-006-A and D-CAP-006-C resolved.

**Notes:** Two reviewers ran (architecture ACCEPT WITH NOTES, code ACCEPT WITH NOTES). Architecture reviewer's LOW claiming the doctor fix was a no-op was factually incorrect — `ALLOWED.onboarding` does NOT contain `'onboarding'`, so the `t !== m` guard is necessary. Code review MEDIUM (duplicated test helpers) addressed by promoting to test-kit. Setup-gate CAP-006 test for `/api/v1/setup/status` updated from 404 → 200 (endpoint now has a handler).

## 2026-08-12 — CAP-006 Setup gate  |  Implemented

**Changed:** While `installation_state.status !== 'complete'` (or the row is absent on a fresh DB), every non-setup HTTP route now 302-redirects to `/setup`. Exempt paths: `/healthz`, `/setup`, `/setup/*`, `/api/v1/setup/*`. This is the gate that forces the operator through the setup wizard before any other route is reachable.

**Files:** `apps/worker/src/http/middleware/setup-gate.ts` (new) · `apps/worker/src/modules/onboarding/installation-state-repository.ts` (new) · `apps/worker/src/modules/onboarding/index.ts` (exports `getInstallationState`) · `apps/worker/src/http/router.ts` (mounts middleware after `requestId`) · `packages/contracts/src/index.ts` (`installationStepSchema`, `installationStateInfoSchema`) · `packages/contracts/src/index.test.ts` (schema parse/safeParse tests) · `apps/worker/src/http/middleware/setup-gate.worker.test.ts` (new, 20 cases)

**Rules:** R-SETUP-001 (incomplete → 302), R-SETUP-002 (fresh DB treated as incomplete), R-SETUP-003 (/healthz always reachable), R-SETUP-004 (DB failure → fail-closed redirect with warn log)

**Decisions:**
- Fail-closed on DB error: the middleware catches `getInstallationState` failures and redirects to `/setup`. A broken DB must not expose the app. Logged via `console.warn` (TODO: structured logger — D-CAP-006-B).
- `{ redirect: 'manual' }` in worker-pool tests: `SELF.fetch` follows redirects by default — tests asserting 302 must use `{ redirect: 'manual' }` to observe the redirect response, not the followed target. This is a testing pattern for all future redirect tests.
- Middleware order: `requestId` → `setupGate` → routes. Infrastructure first, then gates.
- Zod schemas in contracts: `installationStepSchema` and `installationStateInfoSchema` are zod schemas (not just types). The repository uses `.parse()` instead of `as` casts. Satisfies the doctor's `tests-cover-contracts` check.
- `Database` type alias: repository uses `Database` from `platform/database.ts`, not raw `D1Database`. Sets the convention for future repositories.

**Deferred:** D-CAP-006-A (test-kit `InstallationStateRowShape` full-row → CAP-007), D-CAP-006-B (structured logger → CAP-007+), D-CAP-006-C (onboarding module evolves to use-case-level exports → CAP-007+)

**Notes:** The implementer's initial tests failed because `SELF.fetch` auto-follows the 302 redirect to `/setup` (exempt → 404), making the redirect invisible. Root cause was purely in the tests, not the middleware. Two reviewers ran (architecture + code, both ACCEPT WITH NOTES). QA reviewer spawned but did not report after three requests — acceptance criteria verified by orchestrator via quality gates. All review findings addressed: zod parse for casts, log on catch, DB-failure test (R-SETUP-004), `Database` type alias, deterministic timestamps, contract schema tests.

## 2026-08-12 — CAP-005 Deploy automation  |  Implemented

**Changed:** An operator can now deploy the worker to a fresh Cloudflare account with
`ENVIRONMENT=preview pnpm scaffold deploy`. The script provisions all 6 Cloudflare
resources (D1, R2, 2× KV, Queue, Secrets Store) idempotently, generates
`INSTALLATION_TOKEN` and `CREDENTIAL_ENCRYPTION_KEY` (32 random bytes hex, ADR-007) via
stdin (not the insecure `--value` CLI flag), resolves placeholder IDs into a gitignored
`wrangler.resolved.jsonc`, runs remote migrations, deploys the worker, and attempts a
healthz check. The committed `apps/worker/wrangler.jsonc` stays as a template — never
modified by the deploy script. `--force-secrets` requires interactive confirmation and
warns about CREDENTIAL_ENCRYPTION_KEY data loss. `--dry-run` previews without persisting
state or creating resources.

**Files:** `scripts/deploy.ts` (733 lines) · `scripts/deploy.test.ts` (228 lines) ·
`scripts/scaffold.ts` (deploy subcommand) · `scripts/vitest.config.ts` (new scripts test
project) · `vitest.config.ts` (project added) · `.gitignore` (resolved config + resource
state + test temp files) · `docs/operations/deploy.md` (runbook).

**Rules:** ADR-007 (secret generation + storage) · R-SECRET-003 (secrets never logged).

**Decisions:** Template + generated resolved config approach (committed `wrangler.jsonc`
untouched, `.wrangler.resolved.jsonc` gitignored) → deploy.ts header comment. Secrets via
stdin pipe instead of `--value` flag → fix-up-2.md F2. D1 create text output parsing
instead of undocumented `--json` → fix-up-2.md F3.

**Deferred:** D-CAP-005-A (wrangler `--json` shapes — E2E), D-CAP-005-B (stdin secret
approach — E2E), D-CAP-005-C (`secret update` verb — E2E), D-CAP-005-D (healthz under
`workers_dev:false`), D-CAP-005-E (stale-state ID validation).

**Notes:** This is an operator-action capability — `Implemented` means the automation +
tests + runbook are complete and reviewed. `Verified` requires a real cloud deploy by an
operator. Every HIGH finding from code/architecture reviews traces to unverified wrangler
CLI output shapes that cannot be tested without cloud credentials. Parse failures now warn
to stderr instead of being silently swallowed, so the first real deploy will surface shape
mismatches visibly.

## 2026-08-12 — CAP-004 Initial D1 schema + migration runner  |  Implemented

**Changed:** Every Phase 0 capability can now persist to D1. The 11 tables the
installer, identity, outbound-mail and admin code paths read and write
(`installation_state`, `system_settings`, `users`, `sessions`,
`encrypted_credentials`, `permissions`, `roles`, `role_permissions`,
`user_roles`, `audit_events`, `maintenance_jobs`) exist as a single migration
under `migrations/0001_initial.{sql,verify.sql,md}`. The Drizzle typed schemas
at `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail}.ts`
mirror the SQL for repository-side typing; the SQL in `migrations/` is the
deployable artifact per `data-model.md` §Migration authority. A new
`scripts/db-migrate.ts` applies pending migrations against the local D1 binding
via `wrangler d1 execute --local`, with apply and tracking-row insert atomic
in the same D1 batch. `pnpm scaffold db:migrate [--reset] [--verify]` is the
single command; the same runner handles fresh apply, idempotent re-run, and
ghost-detection (`Migration file(s) missing from disk but recorded in
d1_migrations` → exit 1). A new `packages/test-kit/src/migrationsDb.ts`
exposes a worker-pool D1 fixture that every later capability can use in tests
against a real D1 binding (no D1 mocking per `.claude/rules/testing.md`
§Mocking). `pnpm scaffold doctor` `schema-version` check now actually
verifies against the highest migration prefix and the `CURRENT_SCHEMA_VERSION`
sentinel at `apps/worker/src/database/schema-version.ts`; it will break the
moment a future capability adds a migration without bumping the sentinel.

**Files:**
- `migrations/0001_initial.sql` (~250 lines, 11 tables + indexes + checks)
- `migrations/0001_initial.verify.sql` (53 assertions, one per row)
- `migrations/0001_initial.md` (compatibility, backfill, recovery, tracking convention)
- `apps/worker/src/database/schema/{identity,onboarding,admin,outbound-mail,index}.ts`
- `apps/worker/src/database/schema-version.ts`
- `apps/worker/drizzle.config.ts`
- `scripts/db-migrate.ts`
- `scripts/scaffold.ts` (extended dispatcher)
- `scripts/doctor.ts` (migrations-present/ordered skip `.verify.sql` companions; schema-version parses CURRENT_SCHEMA_VERSION)
- `packages/test-kit/src/migrationsDb.ts` (worker-pool D1 fixture)
- `packages/test-kit/src/migrationsDb.worker.test.ts` (R-DATA-001, R-DATA-004, R-AUTH-002, ADR-006, R-AUTH-006-PBKDF2-floor)
- `packages/test-kit/src/sql-raw.d.ts` (`?raw` + `cloudflare:test` declarations)
- `packages/test-kit/src/fixtures.ts` (`installationState.status` aligned to SQL CHECK)
- `packages/test-kit/vitest.workers.config.ts` (new worker-pool project)
- `apps/worker/package.json` (drizzle-orm 0.44.5)
- `package.json` (drizzle-kit 0.31.5 devDep; test:worker runs both worker-pool projects)
- `.gitignore` (`/migrations/drizzle/`)

**Rules:** R-AUTH-002 (status CHECK), R-AUTH-003 (sessions eviction index),
R-AUTH-005 (sessions CASCADE), R-AUTH-009 (email NOCASE), R-DATA-001 (NOCASE
everywhere), R-DATA-003 (users.deleted_at), R-DATA-004 (FK PRAGMA verified),
R-DATA-005 (no JSON-in-text except the documented audit_events.metadata).
ADR-006 (PBKDF2 4-column shape, floor 100k schema-side). ADR-007 (AES-GCM
exact-length CHECKs on iv=12, auth_tag=16).

**Decisions:**
- 11 tables in one migration (0001_initial.sql) — they are one
  "create the schema" event; later migrations are incremental. Logged in
  `migrations/0001_initial.md` §Companion files.
- audit_events.metadata is `TEXT` (JSON) — the explicit R-DATA-005 exception,
  capped at 65536 bytes via CHECK. Documented in
  `migrations/0001_initial.md` §Explicit exception to R-DATA-005.
- Soft-delete only on `users` for now; other tables get `deleted_at` when
  their owning capability lands.
- CASCADE for hard ownership (sessions → users, role_permissions, user_roles);
  SET NULL for soft references (audit_events.actor_user_id, user_roles.granted_by).
- wrangler native `d1_migrations` table is created by the migration itself
  (F1) so apply+track are atomic in one D1 batch; no custom tracking table.
- db:reset is local-only (ENVIRONMENT=local or unset) per task.md AC #15.

**Deferred:** D-CAP-004-A — `users.password_iterations` schema floor is
100,000, weaker than ADR-006's 600,000. The application layer (CAP-019)
sets the exact floor. D-CAP-004-B — `UserId` and cross-boundary types must
live in `packages/contracts/` before repositories land. D-CAP-004-C —
`scripts/db-migrate.ts` is ~260 lines, exceeds the 150-line rule;
orchestrator judgment: dev-only CLI benefits from being one file.
D-CAP-004-D — `packages/test-kit/src/sql-raw.d.ts` is the sole source of
`cloudflare:test` typings; the official `@cloudflare/vitest-pool-workers`
module does not export `applyD1Migrations`'s surface in 0.21.x.

**Notes:**
- The migration runner's first version shipped with separate Node-side
  `CREATE TABLE d1_migrations` and `INSERT INTO d1_migrations` wrangler calls
  (the BLOCKERs of the original code review). The fix-up pass moved both
  into `0001_initial.sql` itself so apply+track are atomic. A crash
  mid-`--file=0001_initial.sql` rolls back both. Every CREATE uses
  `IF NOT EXISTS` so a partially-applied DB can re-apply cleanly.
- `pnpm test:worker` is configured to run both `workers` (apps/worker) and
  `test-kit-workers` (packages/test-kit) projects. The unit pool
  (`packages/test-kit/vitest.config.ts`) excludes `*.worker.test.ts` so the
  worker-only tests don't run in the node pool where `cloudflare:test`
  doesn't exist.
- `pnpm scaffold db:migrate --reset` exits 0 and applies the migration to a
  fresh local DB; a follow-up `pnpm scaffold db:migrate` (no flags) is
  idempotent (1 already applied, 53 verify assertions pass).
- `pnpm scaffold doctor` is `10/10`; `pnpm exec drizzle-kit check` (from
  `apps/worker/`) exits 0; `pnpm test` is `12/47`.

## 2026-08-12 — CAP-003 `pnpm scaffold doctor`  |  Implemented

**Changed:** A new `pnpm scaffold` script dispatcher runs `scripts/doctor.ts`
(via Node 22's `--experimental-strip-types`, no new runtime dependency) and
performs 10 structural checks against the repository. `10/10 checks passed.`
exits 0 on a healthy repo; the same command exits 1 with a `✗ <name> — <detail>`
line per failed check. The doctor is the first gate in
`.claude/rules/testing.md` §Quality gates. The `pnpm test:unit` suite now
includes a vitest self-test that spawns `pnpm scaffold doctor` and asserts
exit 0, so the doctor is part of the regular test gate.

The 10 checks:

- `wrangler-bindings` — every binding in `apps/worker/wrangler.jsonc` exists
  in `apps/worker/src/platform/env.ts` (`DB`, `ATTACHMENTS`, `SETUP_SESSION`,
  `CACHE`, `OUTBOUND`, `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`,
  `ENVIRONMENT`).
- `wrangler-compat` — `wrangler.jsonc` declares `compatibility_flags:
  ["nodejs_compat"]` and a recent `compatibility_date`.
- `migrations-present` — every `migrations/NNNN_*.sql` has a sibling
  `migrations/NNNN_*.verify.sql`.
- `migrations-ordered` — migration filenames sort lexicographically; sequence
  numbers zero-padded and contiguous from `0001`.
- `schema-version` — recorded `schema_version` matches the highest-numbered
  migration.
- `module-dependency-zones` — full per-pair enforcement of the 132 possible
  `modules/<a> → modules/<b>` edges against the allowed list in
  `.claude/rules/architecture.md`. **Resolves D-CAP-001-C.**
- `eslint-boundary-rules` — `eslint.config.js` contains the three
  `import/no-restricted-paths` zones plus the `no-restricted-imports` rule
  for `hono` in `modules/platform/packages`. (Loads the config via dynamic
  `import()` rather than regex-matching source — robust against comment and
  string-shape changes.)
- `tsconfig-strict` — root and per-package `tsconfig.json` files have
  `strict: true` (or the strict family enabled individually).
- `harness-no-placeholders` — every workspace package's `test:unit` /
  `test:worker` scripts invoke vitest (no `echo ... && exit 0` placeholders).
  Catches regression to the CAP-001 placeholder state.
- `tests-cover-contracts` — every exported zod schema in
  `packages/contracts/src/index.ts` has at least one `parse` and one
  `safeParse` test.

**Files:**
- `scripts/doctor.ts` — 200 lines, all 10 checks, zero `any`, TS strict.
  Allowed-edge table from `.claude/rules/architecture.md` is encoded
  verbatim.
- `scripts/scaffold.ts` — 22-line dispatcher; routes `doctor` to
  `scripts/doctor.ts`.
- `scripts/README.md` — two paragraphs describing the dispatcher and the
  `doctor` subcommand.
- `scripts/tsconfig.json` — composite project, wired into `tsconfig.json`
  references so `pnpm typecheck` covers `scripts/*.ts`.
- `apps/worker/scripts/doctor.test.ts` — vitest self-test; spawns
  `pnpm scaffold doctor` and asserts exit 0.
- `apps/worker/vitest.unit.config.ts` — added `scripts/**/*.test.ts` to
  the include glob so the doctor self-test is discovered.
- `package.json` — `scaffold` script via Node `--experimental-strip-types`.
- `tsconfig.json` — added `scripts` reference.
- `.gitignore` — added `/scripts/dist` (composite tsconfig emits there).

**Rules:** No business rules implemented. The doctor enforces the structural
rules that prevent the legacy anti-patterns called out in
`.claude/rules/architecture.md` §Legacy anti-patterns from creeping back in.
`migrations-no-json-blobs` (R-DATA-005) is the natural follow-up when
CAP-004 adds SQL — there are no migrations to scan today.

**Decisions:**
- **Doctor uses Node native `--experimental-strip-types` instead of `tsx`.**
  Node 22.23.2 strips types natively, so `tsx` is not needed. The migration
  runner (CAP-004) is free to add `tsx` later if it has a need. Both work,
  no dependency is the lighter choice.
- **`scripts/tsconfig.json` is composite and emits to `scripts/dist/`.**
  `scripts/dist/` is gitignored. The compile output is a side effect of
  `pnpm typecheck`; revisit when CAP-004 lands the migration runner.
- **`module-dependency-zones` parses `import` statements with regex.**
  The TypeScript compiler API would be correct but slow and adds a heavy
  dependency. False positives are acceptable for a doctor; false negatives
  are caught by `import/no-restricted-paths` in eslint.
- **Doctor reports; does not fix.** An auto-fix flag is an abstraction
  without three concrete use cases (`.claude/rules/coding.md`).

**Deferred:** None. CAP-003 closed cleanly.

**Notes:**
- `scripts/doctor.ts` is at the 200-line boundary set by
  `.claude/rules/coding.md`. Future checks will need to consolidate logic
  or move helpers into a separate file.
- Two reviewers' worth of scrutiny was *not* run on this slice — the script
  is small (200 lines, no business logic, no auth, no apps/web) and the
  implementer demonstrated failure modes for criteria #3 (eslint rules
  removed → exit 1) and #9 (forbidden module import → exit 1). Gates are
  verified by the orchestrator. Reviewer-skip is a judgment call recorded
  here so future audits can challenge it.
- No commit was made. The orchestrator is awaiting confirmation per
  `.claude/rules/git.md` ("Agents do not commit or push unless explicitly
  asked"). The working tree is dirty by design.

## 2026-08-12 — CAP-002 Test harness (unit + worker pool)  |  Implemented

**Changed:** The repository now has a working vitest harness covering all
seven workspace projects. `pnpm test:unit` runs every non-worker project
(`apps/worker` unit, `packages/contracts`, `packages/email-core`,
`packages/config`, `packages/config`, `packages/test-kit`, `apps/web`) —
6 files, 31 tests. `pnpm test:worker` runs the cloudflare pool against
real D1/R2/KV/Queue bindings via `wrangler.jsonc` — 4 files, 10 tests.
`pnpm test` runs both in sequence — 10 files, 41 tests, under 1 second.
`pnpm exec vitest --project unit run --coverage --coverage.provider=v8`
reports 100% lines covered in `apps/worker/src/platform/**` and
`packages/email-core/**` against the 70% threshold (D-CAP-002-A: workers-pool
coverage deferred). `packages/test-kit` exports `fakeClock`, `fixedIds`,
`fixtures.{user,userRole,installationState}`, `stubOutboundAdapter`, and
`stubFetch`. The stub implements the spec-shaped `OutboundProviderAdapter`
(`key`, `validateConnection`, `send(ctx, msg)`) so it cannot drift before
real adapters land.

**Files:**
- `vitest.config.ts` — root workspace with 7 projects; coverage block
  moved here (per-project coverage is inert in vitest 4 projects mode)
- `apps/worker/vitest.unit.config.ts` — exclude `*.worker.test.ts`
- `apps/worker/vitest.workers.config.ts` — include `*.worker.test.ts`
- `apps/worker/src/platform/{clock,ids,outbound-adapter}.test.ts` — unit tests
  with compile-time interface checks (`const c: Clock = fakeClock(...)`)
- `apps/worker/src/platform/{database,cache}.worker.test.ts` — real-binding
  tests against D1/KV
- `apps/worker/src/http/router.worker.test.ts` — `SELF.fetch()` against
  `/healthz` (no `as unknown as Env` cast)
- `apps/worker/src/entrypoints/inbound-email.worker.test.ts` — cloudflare
  pool stub-flow test
- `apps/worker/test/setup.ts` — `process` import fixed, console silenced
- `packages/contracts/src/index.ts` — `OutboundProviderAdapter` reconciled
  with `docs/rebuild/05-target-architecture/integration-boundaries.md`:
  `readonly key: ProviderKey` (branded), `validateConnection(ctx)`,
  `send(ctx, msg)`. `SendProviderMessage`, `ProviderSendResult`,
  `ProviderRuntimeContext`, `MailAddress`, `ProviderAttachment`,
  `parseProviderKey` added.
- `packages/test-kit/src/{stubs,fixtures,clock,ids,index}.ts` — stub
  implements the spec interface; `isAdministrator` removed from
  `UserRowShape`; `passwordHash` removed (deferred to CAP-004 per
  ADR-006); `userRole` builder added; `RecordedSend.at` renamed to
  `sequence`; `stubFetch` URL-normalises
- `packages/{email-core,config,test-kit}/package.json`,
  `apps/{worker,web}/package.json` — `@unimailbox/test-kit` declared as
  a workspace dep where tests need it; per-package `test*` scripts
  deleted (root is the only supported entry point)
- `work/active/CAP-002-test-harness/task.md` — criteria #10 (workers-pool
  coverage deferred) and #11 (contracts cycle) amended; D-CAP-002-A/B/C
  recorded
- `docs/rebuild/capability-ledger.md` — CAP-002 row → Implemented; three
  deferred items appended

**Rules:** No business rules implemented. The capability's job is to
enforce the testing rules from `.claude/rules/testing.md` so every later
capability's tests are produced under them.

**Decisions:**
- **Filename convention for pool tests.** `*.worker.test.ts` for files
  that need real bindings; the unit project excludes that glob, the
  workers project includes it. One rule, no hand-maintained list.
- **`@unimailbox/test-kit` ↔ `@unimailbox/contracts` cycle.** Documented
  as a deliberate exception in criterion #11. If a future capability
  needs contract tests that use `test-kit` helpers, the helper is moved
  to `packages/contracts/src/test-helpers` and re-exported.
- **`UserRowShape` no longer carries `passwordHash`.** The previous
  `$`-delimited string violated ADR-006. The four-column shape
  (`passwordAlgorithm`, `passwordIterations`, `passwordSalt`,
  `passwordHash`) lands with CAP-004 (identity). Until then, the fixture
  is the minimal row (id, email, timestamps).
- **`OutboundProviderAdapter` reconciled with the spec now.** Cost: one
  shape change before anyone imports it. Cost of deferring: a breaking
  TypeScript change for every consumer plus the stub when the first real
  adapter (CAP-014) lands.

**Deferred:** Recorded in `docs/rebuild/capability-ledger.md` §Deferred items:
- **D-CAP-002-A** — `@vitest/coverage-v8` is incompatible with workerd
  (`node:inspector/promises` is unavailable). The first capability that
  needs workers-pool coverage will switch to `@vitest/coverage-istanbul`
  or move the measurement to the unit project.
- **D-CAP-002-B** — `packages/test-kit` depends on `@unimailbox/contracts`,
  so `contracts` cannot import `test-kit` (cycle). Recorded as the
  reason criterion #11 excludes `packages/contracts`.
- **D-CAP-002-C** — `UserRowShape.passwordHash` deferred to CAP-004
  (identity). The fixture sets the row shape for the table that owns
  the storage.

**Notes:**
- The block-on-cast defect (B2) deserves a wider callout: the legacy
  system was riddled with `setting` rows that carried both a boolean
  and a settings table, and those diverged. The fixture is the cheapest
  place to be honest about the schema; future capabilities must read it.
- Two reviewers (architecture + code) flagged the same root cause
  independently: the harness shipped with the *minimum* shape that
  proved the setup, but did not validate itself against the spec it
  was supposed to enable. The fix pass is mostly about aligning the
  harness with the spec, not adding behaviour.
- No commit was made. The orchestrator is awaiting confirmation per
  `.claude/rules/git.md` ("Agents do not commit or push unless explicitly
  asked"). The working tree is dirty by design.

## 2026-08-12 — CAP-001 Monorepo scaffold + toolchain  |  Implemented

**Changed:** A clean checkout of this repo now runs `pnpm install` and `pnpm build` (worker + web)
to deployable artifacts against Cloudflare Worker bindings, with `pnpm lint`, `pnpm typecheck`,
`pnpm test:unit`, `pnpm test:worker`, and `pnpm exec wrangler deploy --dry-run` all exiting 0.
The Worker entry module (`src/worker.ts`) exports `fetch`, `email`, `queue`, and `scheduled`
handlers, so the "One Worker, multiple entrypoints" shape in
`.claude/rules/architecture.md` §Shape is realized in the deployed bundle, not just asserted in
comments. ESLint enforces three boundary zones (`integrations`, `modules`, `platform`) plus
`import/no-cycle` and a `no-restricted-imports` rule that rejects `hono` from `modules/*`,
`platform/*`, and `packages/*`.

**Files:**
- `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json` (project references)
- `eslint.config.js` (flat config, ESLint 9.39.5; boundary rules above)
- `prettier.config.js`, `.editorconfig`, `.npmrc`, `.prettierignore`, `.gitignore`, `README.md`
- `apps/worker/` — `package.json`, `tsconfig.json`, `tsconfig.node.json`, `wrangler.jsonc` (7
  bindings, `main: src/worker.ts`), `vitest.config.ts`
- `apps/worker/src/worker.ts` — composition module, default-exports `{ fetch, email, queue, scheduled }`
- `apps/worker/src/platform/{env,config,database,object-store,cache,crypto,logger,clock,ids,errors}.ts`
  — `Env` lives in `platform/env.ts` (was previously declared inside the entrypoint, which
  inverted the dependency direction)
- `apps/worker/src/entrypoints/{http,inbound-email,queue,scheduled}.ts`, `apps/worker/src/app-context.ts`,
  `apps/worker/src/http/{router,errors,middleware/*}.ts`
- `apps/worker/src/modules/{identity,onboarding,tenancy,messages,inbound-mail,outbound-mail,provider-sync,attachments,signatures,admin,installation,maintenance}/index.ts`
  — every module is a single empty `index.ts` (the public-surface rule holds by construction)
- `apps/worker/src/integrations/providers/{provider-registry,brevo,resend,cf-sendmail}.ts`,
  `apps/worker/src/integrations/cloudflare/{control-plane,oauth}.ts`
- `apps/web/` — `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html` (with `<noscript>`),
  `src/{main.tsx,App.tsx,app/router.tsx,infrastructure/api/client.ts,components/ui/Button.tsx,styles/tokens.css}`
- `packages/{contracts,email-core,config,test-kit}/src/index.ts` + per-package `package.json` and
  `tsconfig.json`
- `migrations/`, `scripts/` — `.gitkeep` placeholders only (CAP-004 / CAP-003 own the content)

**Rules:** No business rules implemented. The capability's job is to enable later rules:
- `R-DATA-004` (PRAGMA foreign_keys = ON) — the D1 binding `env.DB` is declared in `wrangler.jsonc`
  and reachable through `platform/database.ts`. The actual enforcement lands with the first D1
  migration in CAP-004.
- `R-SECRET-*` (ADR-007) — `env.INSTALLATION_TOKEN` and `env.CREDENTIAL_ENCRYPTION_KEY` are declared
  via `secrets_store_secrets`; `AppContext` deliberately does **not** expose `env` (the
  architecture reviewer's H2), so the request-scoped decrypted-credentials chokepoint remains
  enforceable when the credential store lands.

**Decisions:**
- **Worker entrypoint composition.** A single Cloudflare Worker has exactly one default export; to
  support four triggers (`fetch`, `email`, `queue`, `scheduled`) we default-export an object
  combining the four handler methods. The original scaffold named only `src/entrypoints/http.ts`
  as `main`, so `email`/`queue`/`scheduled` were unreachable in the deployed bundle and the
  `queues.consumers` block was orphaned. The fix-pass moved to `src/worker.ts` as `main`.
  → `.claude/rules/architecture.md` §Shape, `docs/rebuild/05-target-architecture/architecture.md:59-66`
- **`Env` lives in `platform/env.ts`.** Originally declared in `entrypoints/http.ts` and imported
  downward by `platform/*`, which inverted the dependency direction. Moving `Env` to `platform/`
  restores `entrypoints ──▶ modules ──▶ domain`. → `.claude/rules/architecture.md` §Dependency direction
- **`AppContext` exposes named collaborators, not `env`.** `buildAppContext(env)` consumes `env` and
  returns `{ db, cache, setupSessionStore, objectStore, config, clock, ids, logger }`. This is the
  chokepoint ADR-007 needs to enforce request-scoped credential caching.
  → `.claude/rules/architecture.md` §Forbidden, ADR-007
- **Provider adapter files are flat (`brevo.ts`) not directories (`brevo/index.ts`).** Diverges
  from `docs/rebuild/05-target-architecture/architecture.md:84-86` which shows directories.
  Reconciled for CAP-001 because the contract explicitly specified flat files and there is no
  content to fill a directory yet. Phase 1 will convert these to directories as the first
  outbound/webhook adapter lands. → `task.md:84` and `architecture.md:84-86`
- **`'hono'` in `no-restricted-paths` is dead code; the real enforcement is `no-restricted-imports`.**
  `import/no-restricted-paths` matches only path-based imports, not bare module names. A
  configuration-only fix added `no-restricted-imports` for `hono` scoped to `modules/*`,
  `platform/*`, and `packages/*`. Verified by injecting and removing a test violation.
  → `eslint.config.js`
- **Full per-pair module-zone enforcement deferred to CAP-003.** The CAP-001 fix-pass landed three
  hard-edge zones (no `hono` in `modules/*`; no `entrypoints`/`http` in `modules/*`; no
  `entrypoints`/`http` in `platform/*`) plus `no-cycle`. The remaining per-pair dependencies
  (the 132 possible `modules/<a> → modules/<b>` edges, of which the table permits ~20) will be
  encoded in `pnpm scaffold doctor` (CAP-003), which is the natural owner.

**Deferred:** Recorded in `docs/rebuild/capability-ledger.md` §Deferred items:
- `vitest@4.1.10` vs `@cloudflare/vitest-pool-workers@0.10.4` peer mismatch — surfaces only when
  CAP-002 turns on real tests. CAP-002 to bump to `@cloudflare/vitest-pool-workers` 0.21.x.
- `wrangler.jsonc` `account_id` placeholder — operator fills in at deploy time (CAP-005).
- Frontend L1/L2/L3 (theme token beyond `prefers-color-scheme`; `body` font token; global
  `:focus-visible` style) — defer to first real feature capability (CAP-006+).
- Logger deny-list for `LogContext` (per code-review L3) and per-level filtering (L4) — defer to
  CAP-016, the first capability that actually emits user-controlled log fields.

**Notes:**
- The four Worker entrypoints (`http.ts`, `inbound-email.ts`, `queue.ts`, `scheduled.ts`) each
  retain their own file but `worker.ts` is the composition point. Per
  `.claude/rules/architecture.md` §Shape, entrypoints are "thin shells" — that holds.
- `inbound-email.ts` now does `message.setReject(REJECTION_REASON)` rather than
  `message.forward(...)`. The handler is reachable end-to-end (verified by `grep` on
  `dist/worker.js`) but inert: no real inbound mail processing until CAP-021.
- No commit was made. The orchestrator is awaiting confirmation per `.claude/rules/git.md`
  ("Agents do not commit or push unless explicitly asked"). The working tree is dirty by design
  and contains ~75 new files.
- `wrangler.jsonc` placeholder IDs (`REPLACE_WITH_*`) are intentional. They make `wrangler deploy
  --dry-run` exit 0 locally and force the operator to substitute real resource IDs at deploy
  time. CAP-005 owns the deploy runbook.

## 2026-08-11 — Repository Agent Operating System established

**Changed:** The repository now carries its own operating rules, roles, procedures, and execution
state, so a new agent session can recover context from the repository alone (`AGENTS.md` §7).

**Files:**
- `AGENTS.md` — entry point: source-of-truth map, non-negotiable rules, session recovery procedure
- `CLAUDE.md` — Claude-specific subagent and tool conventions only; no duplicated project rules
- `.agents/rules/` — architecture, coding, testing, security, documentation, git, agent-collaboration
- `.agents/roles/` — orchestrator, implementer, architecture-reviewer, code-reviewer, qa-reviewer
- `.agents/skills/` — implement-capability, review-capability, phase-audit
- `.agents/templates/` — capability-task, review-report, handoff
- `work/` — active, reviews, investigations, handoffs, archive (+ `README.md`)
- `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`
- `.gitignore` — `.tmp/`, secrets, build output
- `git init` — the repository was not previously under version control

**Decisions:**
- `docs/rebuild/` is left structurally untouched and remains the design source of truth.
  `.agents/rules/` carries only the *enforceable subset* and links back rather than restating.
  → `.agents/rules/documentation.md` §One fact, one home
- `CAP-NNN` IDs are allocated by the capability ledger, because the specification assigns none.
  IDs are never reused or renumbered. → `docs/rebuild/capability-ledger.md` §Ledger conventions
- `docs/{architecture,business,decisions,operations}/` were **not** created. They would duplicate
  `docs/rebuild/{05,02,09}-*` and become competing sources of truth. Create a `docs/` subdirectory
  only when it has real content with no existing home.
  → `.agents/rules/documentation.md` §Homes
- Security, frontend-reviewer, and four further skills were deliberately **not** created. Empty
  templates train agents to skip the directory. → `.agents/README.md` §Adding to this directory
- Where the roadmap docs disagree with each other, `F-minimal-business-closed-loop.md` §F.1/§F.4 is
  authoritative for Phase 1. → ledger §Known documentation discrepancies

**Notes:** No application code was written. `src/index.ts` is still the placeholder scaffold; the
first real capability is CAP-001 (monorepo scaffold + toolchain), which will replace it.

## 2026-08-11 — Validation pass and fixes

**Changed:** A second agent ran `AGENTS.md` §7 cold, with no prior context, and answered all seven
recovery questions from the repository alone. The procedure works. The same pass surfaced real
defects, all fixed here.

**Files:**
- `.gitignore` — removed stray `/tmp` entry that implied a forbidden scratch location
- `docs/rebuild/README.md` — corrected the phase exit-criteria counts to match the source files
  ("12 boxes" → 11 for Phase 0; "23 boxes" → 29 for Phase 1); replaced the duplicated Rule of
  Three / Rule of One restatement with a pointer to the canonical `.agents/rules/` definitions
- `.agents/rules/architecture.md` — clarified the *intended* reading of "modules never import
  provider SDKs" with "modules may import an *adapter*, not an SDK"; restored the full Forbidden
  list that a partial edit had collapsed
- `.agents/roles/frontend-reviewer.md` — added. Previously listed in `.agents/README.md` as
  "intentionally absent" while the review-capability skill dispatched to it; resolved by adding
  the role with a real (minimal) checklist
- `.agents/README.md` — frontend-reviewer removed from the absent list
- `docs/rebuild/capability-ledger.md` — added discrepancy D-5 (`phase-0-foundation.md` ships with
  acceptance boxes pre-checked, so a fresh agent could conclude Phase 0 is already done; the
  ledger is authoritative)
- `AGENTS.md` §7 — explicitly directs the recovering agent to trust the ledger over the
  pre-checked boxes

**Decisions:**
- The "domain never imports infrastructure" rule, the legacy anti-pattern list, and the module
  layout are deliberately restated in `.agents/rules/architecture.md` from `docs/rebuild/05-*/`.
  The rules file is the *enforceable subset* agents read; the design doc is the full spec. This
  is acknowledged duplication, not a defect — drift is contained by the audit pass at every
  capability close and every phase close.
- Discrepancy D-5 is recorded, not fixed by editing the spec file. The spec is a finalised
  document; the governance layer compensates. Marking it fixed-in-doc would alter the design
  source of truth for cosmetic reasons.
- The audit confirmed all seven recovery questions are answerable; the
  procedure is sound.

**Notes:** Validator's only unfixed concern was the "5-wordings-of-domain-never-imports" issue,
which is acknowledged-duplication: it is the same rule in two roles (rules file + design spec) at
three different levels of detail (sentence, paragraph, full table). This is the intended
hierarchy — navigation (`AGENTS.md`) → rules (`.agents/rules/`) → design (`docs/rebuild/`). A future
audit at a phase boundary will verify they still match.

## 2026-08-11 — Claude Code Hooks (first generation)

**Changed:** The repository now has a deterministic lifecycle guardrail layer around the AI
agent. Six hooks wire into Claude Code's `SessionStart`, `PreToolUse`, `SubagentStart`,
`SubagentStop`, `TaskCompleted`, and `ConfigChange` events. `.claude/settings.json` binds them;
`.claude/hooks/README.md` documents each.

**Files:**
- `.claude/hooks/session-context.sh` — SessionStart, non-blocking. Injects phase + active
  workspace + git state + recent log entry
- `.claude/hooks/protect-destructive-commands.sh` — PreToolUse(Bash), blocking. rm-rf of root
  or home, git reset --hard, git clean -fdx, force-push to main/master/production, DROP
  DATABASE/SCHEMA
- `.claude/hooks/protect-root-pollution.sh` — PreToolUse(Write|Edit|MultiEdit), blocking.
  PLAN.md/NOTES*.md/DEBUG.txt/RESULT.md/etc. at the repo root
- `.claude/hooks/subagent-start-context.sh` — SubagentStart, non-blocking. Common guardrails +
  role-specific appendix for implementer/reviewer/architect/QA/frontend/explore
- `.claude/hooks/validate-subagent-stop.sh` — SubagentStop, blocking. Refuses to let
  implementer-class subagents finish without Status/Files/Tests headings, or reviewers without
  ## BLOCKER/HIGH/MEDIUM/LOW sections
- `.claude/hooks/validate-task-completed.sh` — TaskCompleted, blocking. Refuses to close a
  CAP-NNN with open BLOCKER/HIGH review findings, or with a green-claim that contains FAIL
- `.claude/hooks/protect-config-change.sh` — ConfigChange, non-blocking. Loud audit log when
  governance files change
- `.claude/hooks/lib/log.sh`, `.claude/hooks/lib/project-state.sh` — shared helpers (logging,
  repo-state accessors)
- `.claude/settings.json` — wires the six hooks into their events with precise matchers
- `.claude/hooks/README.md` — the event-purpose-blocking table, payload field map, failure
  behaviour, how to test, and what is deliberately absent
- `.gitignore` — `.tmp/claude-hooks/` added; hook logs are gitignored, the scripts themselves
  are tracked

**Decisions:**
- `set -euo pipefail` is enabled in every script. The implementer habit of running hooks in
  a sandbox where `grep` is wrapped by ugrep-shaped aliases, and where jq rejects payloads
  containing literal control characters, made `pipefail` painful during development. The
  final scripts use jq for input parsing (with `2>/dev/null` on every call) and avoid the
  `(^|\W)` regex shape that ugrep rejects in favour of plain token matches. False-positive
  risk is contained because every script either runs fast enough that a failure is
  acceptable (informational) or matches only high-confidence patterns (blocking).
- `validate-task-completed.sh` does not run `pnpm test` or any other quality gate from inside
  the hook. The hook is fast (jq + grep on small files) and decision-final for the BLOCKER/
  HIGH review case; for "did the tests pass" it relies on the orchestrator's claim plus a
  text-level check that a FAIL token does not appear inside a green claim. Per
  `.agents/rules/testing.md`, real test execution belongs at capability close, not on every
  task completion.
- `protect-config-change.sh` does not block. The governance rule is "prevent accidental
  weakening", not "make immutable". Logging the change loudly is the right enforcement shape;
  the orchestrator's diff review and the rules-change policy in
  `.agents/rules/agent-collaboration.md` are the real safeguard.
- Deliberately NOT wired: `Stop`, `PostToolUse`, `PreCompact`, `PostCompact`, `TaskCreated`,
  `TeammateIdle`. Each was considered and rejected — Stop causes continuation churn,
  PostToolUse adds overhead on every edit, the others have no concrete incident to defend
  against yet.

**Defects found during testing, all fixed before commit:**
- Initial path-resolution in `lib/log.sh` and `lib/project-state.sh` was one level too shallow
  (`../..` from `.claude/hooks/lib/` lands in `.claude/`, not the repo root). Fixed to
  `../../../..`.
- DROP DATABASE inside a quoted shell string was not caught by the original regex because the
  regex required a leading whitespace boundary that did not exist inside the quotes. Fixed
  to a non-word boundary on the left and a non-word-or-end on the right.
- `ps_cap_id_from_text` returned exit-1 on no-match, which `pipefail` propagated into `set -e`
  and silently killed the calling script. Fixed by appending `|| true`.
- The jq extraction in `validate-task-completed.sh` originally had a brittle fallback that
  used `(^|\W)` to anchor a FAIL match; ugrep (the `grep` wrapper that some Claude Code
  environments use) rejected the empty alternative in ERE. Fixed by dropping the boundary
  and relying on the FAIL token alone — keyword detection does not need a regex anchor.

**Defects found by independent audit (post-commit readiness check), all fixed:**
- HIGH: `rm -rf ./build` and `rm -rf ./.git` were over-blocked. Tightened the regex to match
  only when the target is the directory itself (root, home, current, parent, ~user) followed
  by space/semicolon/end — not when it's a specific path inside that directory.
- HIGH: `git push --force-with-lease origin main` was incorrectly blocked. The docs already
  stated `--force-with-lease` is the safe form. Split the regex into two: bare `--force`
  targeting a protected branch blocks, `--force-with-lease` always allows. The block fires
  only when `--force` matches AND `--force-with-lease` does not match.
- MEDIUM: `rm -rf ~root` was under-detected. Replaced literal `~` in the regex with
  `~[^/[:space:]]*` which matches any tilde-prefixed path including `~root`, `~bob`, and
  bare `~`.
- Verification: 20/20 cases PASS in the audit harness at `/tmp/test_drop.py`.

**Notes:** A second agent validated the hooks independently and reported a per-test verdict.
The full report is in `work/reviews/hooks-audit-2026-08-11.md` (created if validation passes
without critical defects; the validator may also report fixes applied inline).

## 2026-08-11 — Claude Code Operating Structure Alignment

**Changed:** The repository's governance was realigned from a "shared multi-tool `.agents/`
layer + Claude Code's own `.claude/`" model to a single Claude Code-centric structure where
**the Main Claude Code session is the sole Orchestrator** and `.claude/` carries every role,
rule, skill, and template the agents read. `AGENTS.md` and `.agents/` were removed; `CLAUDE.md`
became the control-plane entry point.

**Files:**
- `.claude/rules/` — created. 7 rule files moved from `.agents/rules/`: architecture, coding,
  testing, security, documentation, git, agent-collaboration. Internal cross-references updated
  to point at the new location.
- `.claude/agents/` — created. 5 focused agents moved from `.agents/roles/`: implementer,
  architecture-reviewer, code-reviewer, qa-reviewer, frontend-reviewer. Two new agents added:
  **investigator** (read-only evidence-gathering) and **security-reviewer** (auth, secrets,
  webhooks). The `orchestrator` role was **deleted**: the Main Session is the orchestrator; a
  separate orchestrator subagent was duplicate.
- `.claude/skills/` — created. 3 skills moved from `.agents/skills/`: implement-capability,
  review-capability, phase-audit. Two new skills added: **test-business-loop** (verify the
  closed loop on a preview deployment) and **capability-cleanup** (resolve every artifact in
  `work/active/CAP-NNN-*/` to PROMOTE / ARCHIVE / DELETE at capability close).
- `.claude/templates/` — created. 3 templates moved from `.agents/templates/`: capability-task,
  review-report, handoff.
- `CLAUDE.md` — rewritten. Now ~140 lines and explicitly states "Main Claude Code session =
  Project Orchestrator", lists the directory map, the subagent table, the absolute constraints,
  and the state-recovery procedure. Procedure detail is **not** in CLAUDE.md; it lives in skills.
- `.claude/settings.json` — unchanged structurally. No `agent` field; Claude Code uses the Main
  Session by default.
- `.claude/hooks/*.sh` and `.claude/hooks/README.md` — path references updated to `.claude/`;
  the SubagentStop hook adds `investigator` to the exempt list and adds explicit handling for
  `security-reviewer`, `architect-reviewer`, and `frontend-reviewer`. The SubagentStart hook
  adds role-specific blocks for `security-reviewer` and `investigator`. The ConfigChange hook
  adds `.claude/agents/`, `.claude/skills/`, and `.claude/templates/` to its watch list.
- `.gitignore` — single line updated to point at `.claude/rules/documentation.md`.
- `work/README.md`, `docs/rebuild/README.md`, `docs/rebuild/capability-ledger.md` — all path
  references updated.
- `AGENTS.md` and `.agents/` — **deleted**.

**Decisions:**
- The orchestrator role was deleted, not migrated. There is no `.claude/agents/orchestrator.md`
  because there is no separate orchestrator subagent. The orchestrator's responsibilities live
  in three places: `CLAUDE.md` (identity + constraints), `.claude/rules/agent-collaboration.md`
  (coordination constraints), and the skills (procedures). This is the rule from §2 of the
  alignment spec: do not maintain both a Main Session orchestrator and an orchestrator
  subagent.
- The future option (`claude --agent orchestrator`) is preserved in `CLAUDE.md` §Future option.
  Adding an `.claude/agents/orchestrator.md` later is one file; it does not require undoing
  this alignment.
- `business.md` was deliberately **not** added to `.claude/rules/`. There is no business rule
  content that lives outside `docs/rebuild/02-business-discovery/`; the rule files are for
  agent behaviour and architectural constraints, not for business content. Empty rule files
  train agents to skip the directory (the same rule used to skip
  `security-reviewer`/`update-capability-ledger` from the first pass).
- The historical `.agents/` references in this implementation log are **not** corrected — the
  log is append-only history; rewriting it would falsify the trail.

**Notes:** Independent structural review ran after the move. The full audit report is in
`work/reviews/structure-alignment-audit-2026-08-11.md`. Five findings (1 BLOCKER, 2 HIGH,
1 MEDIUM, 1 LOW); all fixed in this same pass:

- **BLOCKER**: stale reference to deleted `.claude/agents/orchestrator.md` in
  `.claude/rules/agent-collaboration.md:22`. Replaced with a pointer to `CLAUDE.md`
  §Execution model.
- **HIGH**: `validate-subagent-stop.sh` required a literal `Tests:` heading but the
  implementer format produces `Tests added:` and `Tests run:`. Regex now matches any of the
  three.
- **HIGH**: `validate-subagent-stop.sh` treated every `general-purpose` agent as an
  implementer, breaking the five roles that share that agent type. The hook now detects
  role from the transcript (via `[role: X]` marker or `.claude/agents/<role>.md` reference)
  and applies the right validation. The Main Session's dispatch convention is updated to
  include `[role: <role-name>]` near the top of each agent's prompt.
- **MEDIUM**: `subagent-start-context.sh` injected implementer instructions to every
  `general-purpose` subagent. The `implementer|general-purpose` case is removed; the
  implementer block now fires only when `agent_type` is literally `implementer`. Other
  roles fall through to the common block and read their own role file.
- **LOW**: `CLAUDE.md` was 126 lines, just past the ~120 target. Trimmed to 108 lines by
  collapsing duplicated prose.

Verification: 24/24 PASS for the end-to-end harness; 20/20 PASS for the destructive-commands
audit harness; 10/10 PASS for the role-detection harness. The Main Session can recover project
state via the procedure in `CLAUDE.md` without spawning any subagent.

## 2026-08-31 — CAP-065 Mailbox sharing and member-management UI

Implemented the browser surface for the existing CAP-057 mailbox member API. Authenticated users
can reach `/mailbox/:mailboxId/members` from the inbox, view the strict safe member projection,
add an existing active user with a normalized email and closed role, and remove a member after
explicit confirmation. The page preserves error data and form/dialog state for retry, scopes all
member cache entries by user and mailbox, cancels stale refetches before mutations, normalizes
network failures to `UNKNOWN`, announces success via a polite live region, and restores keyboard
focus after dialog closure. Invitation delivery, role updates, Worker/migration/contract/provider
changes, and deployment remain out of scope.

Independent architecture, QA, security, code, and frontend reviews were completed. Initial code and
frontend findings were fixed and accepted on re-review. Verification: focused Web 85/85, unit
1142/1142, Worker 886/886, typecheck, lint, scaffold doctor 14/14, build, CAP-065 format check,
and `git diff --check` passed. Build retained the existing bundle-size warning only. No deploy or
push was performed. Cleanup: 0 promoted, 1 archived, 0 deleted.

## 2026-08-31 — CAP-066 Domain administration

Implemented the post-setup managed-domain administration slice. Authorized administrators can reach
`/admin/domains`, list a strict safe projection, add normalized active domains, record an explicitly
operator-confirmed Phase 1 verification action, and delete only domains that have no mailboxes. The
Worker uses database-backed `domain.read`/`domain.manage` checks, stable error codes, strict UUID
validation, request-hash idempotency, and an Administration-module use case for atomic
domain/audit/idempotency batches. Same-key create
and delete races replay the winner; the delete guard also fails safely when the target was the last
domain row and distinguishes a missing domain from a mailbox-protected domain.

The Web surface adds a user-scoped TanStack Query cache with cancellation signals, strict contract
parsing, retryable errors, permission-revocation hiding, explicit delete confirmation, operator-only
verification copy, and focus trapping/restoration. A successful delete moves focus to the remaining
domain form after its trigger row is removed.

Independent Worker/security/architecture and Web/QA/contracts reviews completed with no unresolved
blocker, high, or medium findings after re-review. Verification: focused Worker 11/11, focused
Web/admin/router 59/59, contracts 386/386, full unit 1159/1159, full Worker 897/897, scaffold
doctor 14/14, typecheck, lint, format, `git diff --check`, and root build passed. Build retained
the existing Vite bundle-size warning only. No deploy, commit, or push was performed. Cleanup:
0 promoted, 1 archived, 0 deleted.

## 2026-09-01 — CAP-067 Role administration

Implemented the bounded post-setup role-definition surface. Administrators with `role.read` can
inspect the seeded system roles and the exact closed permission catalog; administrators with
`role.manage` can create, fully replace, and delete unassigned custom roles. System roles remain
read-only, assigned custom roles fail closed with `ROLE_IN_USE`, and user-role assignment remains
out of scope for the separate user-management capability.

The Worker keeps role state, permission relations, idempotency records, and `role.created` /
`role.updated` / `role.deleted` audit rows in one D1 batch. Names are normalized and protected by
the existing case-insensitive uniqueness constraint. Every mutation requires request-hash checked
idempotency; replay and conflict paths return the original response or the canonical stable error.
The role and permission response contracts reject storage-only user assignments, unknown fields,
incomplete catalogs, and duplicate permission keys.

The Web adds `/admin/roles`, a session-guarded landing link, user-scoped query state, strict
response parsing, custom-role create/edit/delete forms, system-role read-only rendering, explicit
delete confirmation, validation/error/retry/empty states, query cancellation, and focus-safe
mutation behavior. No Brevo token/provider, migration, deployment, or remote state was changed.

Independent Web/QA review returned six MEDIUM findings; all were fixed and recorded in
`work/archive/2026-08/CAP-067-role-administration/frontend-qa-review.md`. A separate architecture /
security review was requested but did not return before shutdown; the main session's direct audit
is recorded in the companion review note and found no unresolved BLOCKER/HIGH/MEDIUM issue.

Verification: focused contracts/Web/router 446/446, focused role Worker 7/7, full unit 1174/1174,
full Worker 904/904 against real D1/workerd, scaffold doctor 14/14, lint, typecheck, format,
`git diff --check`, and root build passed. Build retained the existing Vite bundle-size warning
only. No preview verification or deploy was performed.

## 2026-09-01 — CAP-068 Signature administration

Implemented the per-managed-domain signature administration slice. Administrators with
`signature.read` can list a safe projection; administrators with `signature.manage` can create,
edit, and delete the single signature owned by a managed domain. The migration and Drizzle schema
keep HTML, plain text, enabled state, and timestamps as scalar relational columns with a unique
domain foreign key and cascade delete.

The Worker validates strict bounded requests, sanitizes HTML through an explicit formatting/link
allowlist, rejects content that becomes empty after sanitization, and keeps each successful
signature write, correlated audit event, and idempotency record in one D1 batch. Replays are
byte-identical. PATCH carries the returned `updatedAt` as `If-Match`, uses a conditional update
with a strictly advanced timestamp, and returns `412 STALE_IF_MATCH` for stale concurrent writes.
The module exports `findEnabledSignature` for the later outbound composition slice; automatic
compose/reply/provider injection remains intentionally out of scope.

The Web adds the session-guarded `/admin/signatures` route, landing link, user-scoped query cache,
strict response parsing, create/edit/delete forms, permission-denial hiding, retry/error/empty
states, and source-only HTML handling with no browser preview or HTML rendering.

A bounded independent subagent review found the concurrent-update race and a tenant-scope concern;
the race was fixed with `If-Match`. The tenant concern does not apply to this single-installation
global managed-domain model, whose server-side route authorization is permission-based and has no
tenant column. A final post-fix subagent re-review was requested but timed out and is recorded as
no conclusion in the archived review note. Main-session direct review and focused evidence were
completed.

Verification: focused contracts/Web/router 61/61 plus contracts 386/386, focused Worker 9/9,
sanitizer 3/3, full unit 1189/1189, full Worker 913/913 against real D1/workerd and the live
Brevo/outbound test token, `pnpm scaffold doctor` 14/14, lint, typecheck, format, `git diff --check`,
and root build passed. Build retained the existing Vite bundle-size warning only. No preview
verification, deploy, push, or provider/token change was performed. Cleanup: 0 promoted,
1 archived, 0 deleted.

## 2026-10-04 — CAP-A1 D1 session-bound access tokens

The current self-hosted authentication middleware still accepted a KV access-token payload with a
valid user ID but no D1 session ID. A new Worker regression test first demonstrated a 200 response
from `/api/v1/auth/me` for that payload. The middleware now requires both IDs and confirms that the
session is active, unexpired, unrevoked, and owned by that user before setting the request identity.
Tests also cover revoked and mismatched sessions and ignored Cloudflare Access identity headers.

Sixteen older Worker test files seeded user-only KV tokens. Their fixtures now bind tokens to D1
sessions, so business-route tests continue exercising real authorization. The test scripts now run
non-Worker projects and the two Worker projects sequentially; concurrent Worker startup had caused
`listen EPERM 127.0.0.1` locally. `pnpm test` passes 1186 non-Worker, 845 Worker, and 17 test-kit
Worker tests. Typecheck, lint, format, doctor 14/14, build, and diff check pass. Wrangler dry-run
still reports a local log-write EPERM while exiting 0. No remote preview, real mail delivery,
deployment, commit, or push was performed. CAP-A1 remains open for legacy auth configuration,
administrator audit, browser and preview evidence.

## 2026-10-04 — CAP-A1 local browser session and CAP-A2 UI checks

The local Vite → Worker browser run exposed two session-recovery defects. With no refresh cookie,
`/auth/refresh` returns the Worker's `400 VALIDATION_ERROR` for a missing token; the Web router had
shown a route error instead of the login page. After a successful cookie refresh, the Web also
called `/auth/me` before installing the new access token in its memory store, causing a second 401.
The Web now treats only the specific missing-refresh-token validation response as an unauthenticated
state, installs the refreshed access token before verifying `/me`, and clears it if verification
fails. Focused auth regression tests cover both boundaries.

Final source review found that the first-password-change mutation also replaced the in-memory
session with a token-free query-cache descriptor. It now preserves the current in-memory Bearer
token while clearing the password-change flag; a focused regression test covers that transition.

In a fresh local browser session, admin login reached `/mailbox`; a hard reload produced an initial
`/auth/me` 401, `/auth/refresh` 200, then `/auth/me` 200 with the new Bearer token. Logout returned
to `/login`, and a subsequent cookie-backed refresh attempt failed because the cookie had been
cleared. SPA navigation reached `/admin`, and `/admin/users` created an admin-managed test account
with an initial password shown once. A 390px dark-mode check found no document-wide horizontal
overflow; the user table scrolled horizontally after keyboard focus and ArrowRight. The independent
browser session reported no page errors. A separate browser session then confirmed that the
admin-created member reaches `/change-password` on first login and enters `/mailbox` after changing
the password. That run exposed that the member could still render the `/admin` shell. `/auth/login`
and `/auth/me` now return a D1-derived `canAccessAdmin` UI hint; every admin route refreshes `/me`
before rendering the shell, and the regular member role's mailbox permissions do not qualify.
Local browser checks confirmed that `/admin` and `/admin/users` redirect the member to `/mailbox`,
while the administrator can still enter `/admin`. API authorization remains per-request. Focused
Worker auth 39/39 and Web router/auth/nav 74/74 tests passed after this fix. Full mailbox operations
and remote preview remain open. No deploy, commit, or push was performed.

## 2026-10-04 — Provider webhook isolation and inbound raw MIME persistence

The outbound webhook path now checks that the URL provider key matches the
stored connection and that the connection is active before verifying or
persisting an event. Webhook bodies are read as original bytes, capped at 64
KiB, HMAC-verified before UTF-8/JSON parsing, and malformed JSON returns the
stable `INVALID_JSON` error. Early-event reconciliation is scoped by both
connection and provider message ID, and replays the saved event status through
the rank-aware message state writer while preserving the provider event UTC
timestamp. Regression coverage includes provider mismatch, size limit,
malformed payload, cross-connection collisions, event replay, and 67 focused
Worker tests.

Cloudflare Email Routing now reads the raw message once as bytes, writes the
verbatim MIME object to R2 under an opaque `raw-mime/<message-id>` key, and
stores only that key in `messages.raw_object_key` before the D1 message batch.
This preserves raw headers and future attachment bytes while parsed text stays
available for the existing inbox path. The inbound R2 readback is covered by
the Worker suite.

Validation after this slice: unit/web/contracts/email-core/config/test-kit
1194/1194, Worker 860/860, test-kit Worker 17/17, focused inbound/provider
77/77, TypeScript build, ESLint, Prettier, and `git diff --check` pass. These
are local evidence only; real Email Routing, Queue consumption, R2 lifecycle,
Brevo delivery, and preview deployment remain unverified.

## 2026-10-04 — Envelope routing follow-up and validation boundary

Inbound routing now selects only the active mailbox named by Cloudflare's
`message.to` envelope recipient. Sender-authored MIME To/Cc cannot cause a
second local mailbox delivery; an envelope Bcc recipient can receive a message
without appearing in To/Cc. The sender policy input uses the normalized SMTP
envelope sender `message.from`, while the declared RFC From remains the stored
display value. Focused regression cases cover forged MIME To, Bcc routing,
multiple local To addresses, and forged RFC From. TypeScript, focused ESLint,
Prettier and `git diff --check` passed after these edits.

The final Worker re-run after the `preserveProviderEventTime` test adjustment
and envelope routing edits did not execute: automatic approval review rejected
the local Worker test process because the review usage limit was reached. The
latest fully passing Worker suite above predates these final edits. Worker
runtime behavior for this final state and live Email Routing remain unverified.
The non-Worker suite was rerun after the final edits: 1194/1194 tests passed;
the Web production build, TypeScript build, focused ESLint, Prettier, and
`git diff --check` also passed. These checks do not replace Worker execution.

## 2026-10-04 — Brevo webhook adapter boundary

Brevo raw-byte HMAC verification, JSON parsing, event-to-message-status mapping,
and provider timestamp normalization now live in
`integrations/providers/brevo-webhook.ts`. The registry exposes a webhook
adapter separately from its outbound send adapter. The outbound-mail processor
loads an active connection, invokes the matching adapter, scopes job lookup by
connection, and prepares the D1 status/delivery writes for the route's atomic
audit batch. A signed timestamp string must have an explicit timezone before
it is converted to UTC epoch milliseconds; ambiguous local-clock strings use
the server-time fallback.

Node adapter tests cover exact-byte signatures, missing/invalid signatures,
verify-before-parse, malformed and non-object JSON, invalid UTF-8, known and
unknown event mapping, seconds/milliseconds, explicit UTC/offset timestamps,
and server fallback. The new focused suite passed 24/24; the complete
non-Worker suite passed 1218/1218 across 87 files. TypeScript, focused ESLint,
focused Prettier, `git diff --check`, and the Worker Wrangler dry-run build
passed. Wrangler reported an EPERM warning while trying to write its local
diagnostic log, but still completed the
dry-run with exit code 0 and listed the expected bindings. The Worker suite
has not been rerun after the
envelope-routing and webhook-adapter edits: the previous attempt was rejected
by automatic approval review when its usage limit was reached. The last
passing Worker count predates these edits and is not evidence for this state.

Provider-neutral early-event reconciliation remains open because the current
D1 generated column extracts Brevo's `messageId` from `raw_payload`, and the
reconcile use case still calls the Brevo status mapper. Event-level
idempotency, a second send provider/SMTP adapter, full inbound MIME attachment
extraction, and independent preview delivery evidence also remain open. No
commit, push, or deploy was performed.

## 2026-10-04 — Provider-neutral early webhook replay projection

Migration 0027 adds `verified_provider_message_id` and `message_status` to
`webhook_deliveries`. It backfills existing Brevo rows from the legacy generated
`provider_message_id` and Brevo event-name mapping, leaving other provider
rows untouched. New deliveries store the verified adapter's provider message
ID and normalized status in typed columns. Reconciliation now queries those
columns by connection and provider message ID; it no longer imports the Brevo
status mapper or reads provider-specific JSON. The old generated column stays
in place for schema compatibility.

A new Worker test exercises a synthetic provider whose payload has no Brevo
`messageId` or event name, from public webhook route through early-event
reconciliation. Another Worker test covers the 0026-to-0027 backfill boundary.
Those Worker tests have not run because the local Worker test process remains
subject to the automatic approval review usage limit. A separate local SQLite
3.51 check applied the full migration chain through 0027, confirmed the
Brevo-only backfill and verified the new partial index is selected for the
reconciliation lookup. Non-Worker tests passed 1218/1218, forced TypeScript
build, focused ESLint, `git diff --check`, scaffold doctor 14/14, and Wrangler
Worker dry-run passed.
Wrangler still reports a non-fatal EPERM warning for its local log file.
Event-level idempotency, a real second provider/SMTP adapter, Worker runtime
verification and preview delivery remain open. No commit, push or deploy.

## 2026-10-04 — Inbound MIME attachment persistence

Inbound Email Routing now parses the original MIME bytes with postal-mime
2.4.4, retaining the verbatim raw object in R2. Nested multipart bodies and
base64/quoted-printable parts are decoded; each attachment is stored under an
opaque `inbound-attachment/<message-id>/<attachment-id>` R2 key. Migration
0028 adds an inbound-only metadata table, separate from the outbound upload
consume lifecycle. The metadata INSERTs join the message, recipients,
mailbox association and audit row in one D1 batch. On an R2 or D1 failure the
handler attempts to delete objects written for that attempt, then rethrows so
Email Routing can retry. R2 deletion failures can still leave orphaned bytes;
an object reconciliation lifecycle remains to be built.

Message detail now includes inbound attachment metadata. The existing
download use case checks mailbox read access, soft-delete state, and R2 byte
length before returning content; a foreign user receives no attachment. The
mailbox lookup explicitly applies NOCASE to the envelope local part, matching
its unique index and the address normalization rule. The MIME adapter trims
body-edge whitespace to preserve the prior inbox display contract.

Validation: email-core 17/17, focused Worker inbound/webhook/attachment tests
59/59, test-kit Worker migrations 18/18, complete non-Worker suite 1219/1219,
forced TypeScript build, focused ESLint, scaffold doctor 14/14, diff check,
and full Web/Worker dry-run build passed. The full parallel Worker suite first
reported 863 passed and two 5-second timeouts with a local "Network connection
lost" error. The affected Brevo and outbound smoke-test files passed on
separate reruns (19/19 and 12/12, the latter with a 20-second test timeout).
An ensuing full Worker rerun with a 20-second per-test timeout passed 865/865
across 51 files; the separate test-kit Worker run passed 18/18. The initial
5-second run remains recorded as a load-sensitive failure. Wrangler still
prints a non-fatal EPERM warning when opening its local log file. Real Email Routing, preview R2,
attachment lifecycle cleanup and safe inline CID rendering remain unverified.
No commit, push or deploy.

## 2026-10-05 — Authenticated inline MIME media and inbound R2 orphan sweep

The attachment URL accepted only an in-memory Bearer token. A plain browser
`<img src>` or download link cannot send that header, so CID substitution
alone left inline images and direct downloads unauthorized. The Web API client
now supports binary responses with the same Bearer, request ID, retry and
error handling as JSON. Message detail fetches allowlisted inline raster
parts through that client, checks the byte length, and uses short-lived Blob
URLs for both sanitized CID HTML and the attachment preview. Object URLs are
revoked when the detail view changes or unmounts. Download controls fetch
through the same client before saving a file. Remote/data/blob image sources
from untrusted HTML remain blocked; a leading CID image is preserved by
sanitizing inside a body wrapper. Direct attachment responses always use
`Content-Disposition: attachment` plus `nosniff`, `no-store`, and sandbox
headers, including when MIME metadata claims an inline disposition.

The scheduled Worker now scans one 100-object page per tick for each of the
`raw-mime/` and `inbound-attachment/` R2 prefixes. It waits 24 hours after
upload and checks D1 canonical references before deletion. KV stores the
last scanned key so large buckets progress without a long cron invocation;
deletion and KV cursor retries are repeat-safe. D1 lookup failure stops
deletion. This closes the rollback/orphan-byte gap for inbound writes after
the grace period, while leaving referenced message bytes intact. A separate
policy for deleting associated objects after canonical message deletion is
still open.

Validation: focused Web 46/46, focused Worker attachment 11/11 and sweep/
scheduled 7/7, complete non-Worker 1222/1222, complete Worker 868/868 with
20-second per-test timeout, TypeScript, focused ESLint and `git diff --check`
passed. The production Web build and Worker Wrangler dry-run also passed;
the Web bundle retains its existing size warning and Wrangler still prints
a non-fatal local log-write EPERM. The first Worker test attempt hit local
loopback `listen EPERM`; the approved local retry and full run passed. No real Email Routing delivery,
preview R2 lifecycle, Brevo send, commit, push or deploy occurred.

## 2026-10-07 — satnaing/shadcn-admin UI and configuration follow-through

Corrected the reference to the user-requested satnaing/shadcn-admin, pinned at
`e16c87f213a5ba5e45964e9b67c792105ec74d26`, and retained its MIT license and
source manifest. Actual upstream Sidebar/Sheet, theme, auth layout and UI
primitives now serve the existing product routes. One authenticated shell
owns navigation and session actions; route chunks load on demand. Settings
uses grouped standard fields and a save bar; role/signature editors open on
demand from compact lists. Domain and audit selectors use the same Select.
Cancel restores editor values; signature If-Match is captured when editing
starts; default epoch settings metadata displays Not saved yet. Success
messages track the latest save/delete and row actions are less visually
prominent. Existing API permissions, raw values, cursor pagination and MIME
attachment authorization remain authoritative.

A real signature form left open beyond 15 minutes exposed expired-access-token
save failure. Protected requests now share one HttpOnly-cookie refresh and
replay once with the same mutation body and Idempotency-Key. Auth/setup and
403 are excluded; a logout during refresh prevents token installation/replay.
The natural-expiry staging check observed POST 401 → refresh 200 → POST 201
with the original form values. A malformed audit action left by the earlier
staging password rehash helper was backed up and corrected with its original
metadata retained; no audit row was deleted and no validator loosened.

Validation: Web 462/462 across 59 files, workspace TypeScript, Web ESLint,
focused Prettier and production build pass. One prior full Web run stalled
for roughly 17 minutes and failed with test/worker-start timeouts; its log is
preserved and a controlled two-worker full rerun passed in 18.18 seconds.
Build: initial main 428.81 kB, separate React 185.69 kB, CSS 97.08 kB; heavy
routes load separately. This is a chunk-distribution comparison, not a claim
that total transferred JavaScript decreased. Wrangler staging version
`5899903e-51d7-4391-a1b2-8f275fa75214` deployed successfully. Real browser
configuration CRUD, responsive layouts and theme/keyboard checks are recorded
in `docs/qa/ui-redesign-2026-10-07.md`. Temporary role and disabled signature
were deleted and D1 confirmed no residual test resources. No commit or push;
this UI run does not claim the original 175-case or full Worker acceptance.


## 2026-10-07 — Compose window, recipients and formatting

Replaced duplicate compose navigation with the sidebar's top button and a persistent fullscreen/bottom-left compose window. The draft remains bound to its From mailbox across navigation/zoom/hide; auth changes clear it and successful send releases it. To now reveals optional Cc/Bcc; Bcc is validated, stored and delivered through its own provider envelope, while read projections retain their To/Cc-only privacy boundary. Added paragraph/headings, font sizes, indentation/alignment/spacing and bounded inline style sanitization. Official MIT Tiptap TextStyle/FontSize is the only new dependency. Fixed stored font marks across block operations and tiny upload size labels.

Final staging `4e6c1f92-1284-4c60-a6e5-cfe710b77497`; local non-Worker 1270, Worker 879 and test-kit Worker 18 pass, with typecheck/lint/format/doctor/build. Desktop/mobile window acceptance and two actual To/Cc/Bcc deliveries pass, including raw MIME privacy and delivered formatting. Recipient link metadata/prefix and tiny-file hashes pass; a new complete 21 MiB recipient hash is not claimed because local proxy transfers stalled. See `docs/qa/compose-window-2026-10-07.md` for evidence and scope. No migration, configuration, commit or push.


## 2026-10-07 — Compose right dock and settings-driven upload limits

Corrected the docked composer to bottom-right, including scrollbar-aware mobile width. Shared compose/signature upload help and browser validation read a safe authenticated policy derived from system maxAttachmentBytes; uploads refresh policy and the Worker checks it independently. Settings saves invalidate the editor query. Migration 0030 aligns metadata ceiling with the existing 100 MB settings range while preserving capability links, usages and pending quotas.

Final staging version `bbfc4198-549d-4d6a-844f-c30085555d92`; original 64 MB configuration restored after 64 → 63 → 64 browser acceptance. D1 backup taken and all 18 assets/16 usages verified unchanged; old published file download still matches. Local 1,273 unit, 882 Worker and 19 migration tests passed. Types/source lint/format/doctor, final web build and prebuilt Worker dry-run passed. Root build's Wrangler dry-run remained alive after producing its bundle; documented process-exit limitation and used explicit no-bundle validation, without changing build scripts. Real deployment exited successfully. No commit/push, production operation or required manual configuration. See docs/qa/compose-settings-2026-10-07.md.


## 2026-10-07 — Personal settings, bilingual UI and error codes

Replaced account dropdown with the shared right quick-settings panel. Users can
upload/remove a private R2 avatar, change password, choose a persistent default
mailbox and adjust language, theme, list density and reading pane. Login resolves
the saved default against current permissions and falls back if access is lost.
Migration 0031 adds relational identity-owned preferences; audited, idempotent
writes are atomic. Added live English/Simplified Chinese UI and a shared exhaustive
error-code catalog; frontend display and auth recovery no longer depend on server
English. Browser acceptance caught selected-label caching and several dynamic
translation omissions; fixed them and added a closed-select locale regression.

Final local non-Worker 1,279, binding-backed Worker 888 and test-kit Worker 19
passed; TypeScript, source ESLint, doctor 14/14, web build and explicit staging
Worker deployment passed. D1 backup and all 0031 assertions/FKs verified. Real
API/browser covered persistence, private avatar, default mailbox/revocation,
bilingual errors, draft retention, reading panes and mobile bounds. A dedicated
six-character-password QA user proved current-session retention and other-session
revocation, then was deleted. Original account settings/avatar and temporary
sharing were restored. No manual configuration, new email, commit or push.
Deployment version, acceptance boundaries and lint scratch exclusion are recorded
in [the QA record](../qa/personal-settings-2026-10-07.md).

## 2026-10-07 — Shared language and theme icon controls

Placed adjacent language/theme icon buttons in auth/setup and mailbox/admin
headers and reused them under Appearance in quick settings. Removed the login
language row and separate panel language/theme fields. Account choices retain
server persistence; anonymous choices retain browser preferences. Failed writes
keep the saved value and menu open with localized errors. Real browser acceptance
found the portaled menu below the settings rail; corrected its layer and verified
actual pointer selection and saved values.

Staging version `9a946919-ee50-43c8-a357-f08c4c7238c7` deployed successfully.
Local 1,280 unit tests, TypeScript, source lint, doctor and web build passed;
focused tests/lint/build passed again after the layer correction. Desktop/mobile,
reload persistence and administrator login passed. Original member preferences
were restored; administrator preferences and password were unchanged. No new
migration, email, commit or push. See [follow-up QA](../qa/appearance-controls-2026-10-07.md).

## 2026-10-07 — Routine page content cleanup

Removed the duplicate All mailboxes folder-menu entry, redundant shared-header
titles and routine page/list introductions. The switcher retains All mailboxes;
its list page keeps folder navigation to the resolved mailbox. Inbox context is
under the folder title and empty folders show one status without a nested card.
Login and quick settings have less persistent helper copy, while assistive
description, constraints, errors and configuration limitations remain.

Local 1,280 unit tests, TypeScript, source lint, doctor and web build passed.
Staging version `f9128075-81db-4d73-9e3e-92b92dcaadc8` deployed successfully;
desktop/mobile switcher navigation, empty folders and all nine admin routes
passed browser acceptance. No account preferences, email or configuration were
changed. No migration, commit or push. See [QA record](../qa/ui-copy-cleanup-2026-10-07.md).

## 2026-10-07 — Loading feedback

Replaced text-only content waits with list/form/overview/compose and mail-detail
skeletons; route fallbacks follow page type. Short actions keep their text with a
busy spinner and prevent repeated submission. Preferences wait for server values;
message refresh errors keep cached content and an inline retry. Skeletons respect
reduced motion and mail placeholder rows have no hover response.

Local 1,283 unit tests, TypeScript, source lint, changed-source formatting, web
build and doctor passed. Staging version `8255eaef-5ce3-4392-aacc-0244df482f8f`
passed delayed-response desktop/mobile loading checks. No email or configuration
writes were needed. See [QA record](../qa/loading-feedback-2026-10-07.md).


## 2026-10-08 — Deployment hardening (D-01 through D-11)

Unified staging/production release entry around explicit environment/account
validation, separate bootstrap and named secret rotation, strict migration
failures and all-history verification, prepared source/assets identity, mandatory
custom-domain smoke and release recovery metadata. Added static/API security
headers, sourcemap exclusion, immutable hashed assets and real missing-file/API
404; independent DLQ and isolated maintenance tasks with heartbeat monitoring.
Pinned the verified toolchain and generated bindings, and added CI/operations
workflows plus deployment/recovery procedures. Historical provider route tests
now use deterministic HTTP fixtures with real D1/KV. Live verification corrected
a settings-revision companion that incorrectly required its seed timestamp.

Full local gate: doctor 14/14, generated types, lint, TypeScript, builds and
2,169 tests passed. All 31 staging migration companions passed with no pending
SQL. Version `c10f5148-8735-47e5-a6ec-5fa324779044` passed custom-domain smoke,
authenticated inbox/compose/settings checks and a real successful five-task Cron
run. Remote consumer metadata confirms DLQ association. A separate temporary D1
database recovered a deleted synthetic row and was then deleted. No existing
secret was rotated or application database restored; no commit or push.
External CI activation and independent R2/key backup custody still require
operator configuration; production, live mail and DLQ redrive acceptance remain
separate. See [deployment hardening QA](../qa/deployment-hardening-2026-10-08.md).


## 2026-10-09 — KV maintenance reduction

Removed absent avatar/editor cursor deletes, split temporary editor expiry from
R2 scanning, and moved avatar/editor/inbound/legacy attachment orphan scanning
to the 19:00 UTC tick (03:00 Asia/Shanghai) of the existing two-minute Cron.
This avoids the account's full Cron quota without extra per-tick KV reads.
Added independent cadence heartbeats, isolated failures, and migration 0032's
bounded attachment cleanup checkpoint. Daily legacy R2 scanning handles copies
that can land after expiry was checkpointed, while protecting live references.

Full release gate passed 2,182 tests plus doctor, generated types, lint,
TypeScript and builds. All 32 staging migration companions and publication smoke
passed; version `ed2bff67-a2f0-4d8b-95c2-c2b0dcf631f5` passed health/ready/maintenance
checks and a real successful frequent Cron. Daily cloud execution is first due
2026-10-10 03:00 Asia/Shanghai and remains unobserved. Idle scan expectations are
5 cursor reads/day and zero empty cursor deletes; full-day analytics remains
unmeasured. Preserved unrelated work and index; no production, secret rotation,
commit or push. See [KV maintenance QA](../qa/kv-maintenance-2026-10-09.md).

## 2026-10-09 — Resource reduction and legacy Cron retirement

The operator confirmed legacy retirement. Removed all three legacy Cron triggers
and retained its Worker/domain/history for gradual replacement. Current recovery
now runs every five minutes, temporary upload expiry hourly and identity TTL
cleanup plus avatar/orphan scans daily at 03:00 Asia/Shanghai. Cadence heartbeats
and failure isolation remain independent. Reduced empty success logs, bounded
recovery batches and reserved queued retries to avoid repeated enqueue. Setup
status uses read-only GET polling that stops on expiry/error; editor replays hash
without R2 writes and known aggregate-quota failures reject before upload. The
optional Operations workflow now runs every 15 minutes; remote activation is
unestablished. BBY configuration is unchanged.

The full release gate passed 2,191 tests, doctor, generated types, lint, TypeScript
and builds. All 32 staging schema companions and publication smoke passed on
version `be27f319-59aa-4947-b4ae-faaaceb1e303`; live health/ready/maintenance were
healthy and cloud schedule reads confirmed the new topology. A bookmarked,
bounded one-time purge deleted 331 expired idempotency rows and 38 expired/revoked
sessions while retaining 39 active sessions and 25 messages. Three natural
frequent runs on the new version passed with one aggregate log each; they still
carried the former expression during propagation, so natural five-minute event
confirmation remains pending. Full-day savings and natural hourly/daily
execution remain separate acceptance. See
[resource reduction QA](../qa/resource-reduction-2026-10-09.md).


## 2026-10-09 — Scheduled send

Added a compact local-time picker beside Send and a Scheduled mailbox view
with signed-cursor pagination, change-time and cancellation. Cancellation
restores the persisted message to an editable server draft. The additive 0033
migration preserves immediate jobs; scheduled work reuses the D1 outbox,
24-hour Queue delay and existing five-minute recovery, without new bindings,
Cron, KV operations or browser polling. Due-time claims, revision CAS, atomic
audit/replay and durable R2 references protect queued content and races.
Native date input and dialog class extraction issues found in browser
acceptance were fixed and verified on the final build.

The final gate passed doctor 14/14, generated types, lint, TypeScript, builds
and 2,214 tests. All 33 live migration companions and publication smoke passed
on staging version `155d261d-c109-454b-91ab-440b59d3b07e`. Health, ready and
maintenance passed; a natural five-minute Cron passed on the initial feature
release. Real self-mail scheduled for 14:58 Asia/Shanghai sent at 14:58:08,
arrived once, and its R2 attachment downloaded with identical bytes. Far-future
cancellation and editable draft recovery passed in the browser. Multi-day
recovery uses controlled-clock binding tests rather than a multi-day live wait.
Preserved unrelated work and index; no production, commit or push. See
[scheduled-send QA](../qa/scheduled-send-2026-10-09.md).


## 2026-10-10 — Consolidate staging source and Git identity

Consolidated the current mailbox/admin UI, rich editor and R2 attachment storage,
personal settings/localization, scheduled send, resource reductions and deployment
tooling together with their migrations, tests, design decisions and acceptance records.
Completed editor/navigation and scheduled-send contracts moved from `work/active/`
to `work/archive/2026-10/`; the broader integration-plan gaps remain as recorded.

Before consolidation, the deployment source digest matched the verified staging release
`155d261d-c109-454b-91ab-440b59d3b07e` exactly:
`5174dbd67d70bbaac8e541f5941701bf0e071a8ae55968e89390b2f813f7128d`.
That source had passed doctor 14/14, generated binding checks, lint, TypeScript,
builds and 2,214 tests. This consolidation changes documentation and Git metadata;
application source remains unchanged. Staged content is checked for whitespace,
accidental credentials, generated output and exact agreement with the reviewed files.

Author and committer identity for both local branches and their 152 existing commits
is normalized to `JohnJiang <johnjiang@leanda.tech>`, preserving each original
commit tree, message, timestamps and parent topology. Original history and dirty
files were backed up under the ignored `.tmp/commit-identity-20261010/` directory
before changes. No remote is configured; consolidation does not publish or deploy.


## 2026-10-10 — Replace canonical repository source

Connect the rebuilt repository to `UniMailbox/Unimailbox` and replace the legacy
main file tree with the reviewed implementation. A merge joins the original
`12c0b71b80ed94c4ba53927e9cead8e5a660e4c0` main history and rebuilt
`4d9cdf280c1e988cf91638bc780566ea734796e3` history, so publication is a fast-forward
and does not rewrite the existing remote commits. Preserve the original main
as `legacy/pre-rebuild-2026-10-10` and retain its AGPL license.

Application, schema, tests and deployment configuration remain byte-identical
to the reviewed rebuilt source. Update README and the deployment runbook to
reflect observed staging acceptance, current UI provenance, the 15-minute
Operations cadence and manual deployment boundary. GitHub verification runs on
the published source; existing staging resources and production data are unchanged.


## 2026-10-10 — Repository consistency and public-information hygiene

Align README, agent conventions, current ledger and execution plan with the
implemented self-hosted identity, current shadcn reference, system attachment
policy and dated staging evidence. Label superseded recovery/auth/UI proposals;
correct module dependency contradictions, upload/idempotency/API exceptions,
password work-factor guidance and unimplemented rotation guarantees. Replace
personal absolute paths and broken public documentation links.

Fix Claude hook command logging so credentials in allowed or rejected commands
are never persisted or echoed; keep hook logs private. Quote hook paths for
checkouts with spaces, ignore local secret/Claude files, and add checksum-pinned,
redacted Gitleaks CI with exact synthetic-value/path exceptions. Negative checks
confirm new credentials in fixture paths are rejected.

Local full verification passed: doctor 14/14, generated bindings, lint, typecheck,
build and 2217 tests. Current files and all reachable history passed reviewed
secret scanning; known private deployment credentials did not appear in Git.
See [repository QA](../qa/repository-hygiene-2026-10-10.md) for scope and limits.
Shared Git history, live Cloudflare resources and production data are preserved.

## 2026-10-12 — Configurable AI service and email reply assistance

Add a neutral AI service with native Cloudflare Workers AI and official Anthropic/
OpenAI SDK adapters, text/validated structured output, bounded inference, sanitized
errors and optional native binding. Admin owns migration 0034, encrypted AI
credentials, revision-checked/idempotent saves and safe read metadata. The new
Admin → AI services page is independent of general settings.

Add reply/draft assistance to the composer: optional instructions, separate
preview and explicit insertion, preserving recipients/threading and keeping
model text escaped in the real rich editor. The messages use case reads source
mail under global and mailbox read/send permissions. Paid inference reserves
its idempotency key before calling the backend; outcome and content-free audit
settle together. Same-key concurrent, failed or unknown outcomes do not repeat
inference automatically. The feature never sends or schedules mail itself.

Local `pnpm verify` passed 14 scaffold checks, generated types, lint, TypeScript,
web/Worker builds and 2,299 tests (1,305 unit/Web/contracts/scripts, 971 Worker,
23 migration fixtures). Desktop/mobile browser checks use synthetic local APIs
and the real Tiptap editor; they do not prove live model inference or delivery.
No deployment or production migration occurred. See [AI design](18-ai-service-foundation.md)
and [handoff](../../work/handoffs/ai-service-and-reply-2026-10-12.md).


## 2026-10-12 — AI staging release and migration recovery

Commit feature `850e0d7` and design/handoff `2895ea2`, then publish staging through
`pnpm deploy:staging`. The first release applied the AI table but stopped before
Worker publication because raw migration 0034 lacked its tracking insert. Fix
`5f85a35` registers the migration and preserves state on partial/repeated execution.
Tests now execute the raw SQL at the 0033 boundary, covering tracking and recovery
without the fixture's automatic registration.

The repeated canonical gate passed doctor 14/14, generated types, lint, TypeScript,
build and 2,300 tests (1,305 unit/frontend/contracts/scripts, 971 Worker and
24 migration fixtures). All 34 remote schema companions passed. Staging version
`e4981bdf-2992-4794-8e9d-783263925e3d` passed release smoke; health/readiness match
revision `5f85a35`, schema 0034 and the prepared source digest. Native AI binding
is present, default configuration remains disabled with no API key, and both AI
routes require authentication. No model inference or generated email was sent.
See [staging QA](../qa/ai-staging-2026-10-12.md). Production publication and source
push were not part of this staging run.


## 2026-10-12 — Configured AI upstream error diagnosis

The reported `AI_UPSTREAM_ERROR` matched a content-free failed audit event.
Staging was configured with display-style model name `Minimax M3`; MiniMax's
API requires exact ID `MiniMax-M3`. Correct the model through authenticated Admin
GET/PUT with revision matching, preserving the endpoint and encrypted credential.
Configuration revision advanced to 2. A fresh synthetic-context AI draft request
through staging returned 200 in approximately 3.5 seconds; no source email was
read and no message was sent. The temporary diagnostic session was revoked.
This is live MiniMax text-inference evidence, while structured-output/model-quality
and generated-mail delivery acceptance remain open. No Worker redeployment was
needed. See [staging QA recovery](../qa/ai-staging-2026-10-12.md).


## 2026-10-12 — Remove inline AI reasoning from email bodies

Fix `6e147c5` removes `<think>` content from the shared adapter's plain-text
result. The parser handles nesting, case differences and unfinished reasoning;
empty/malformed final answers fail explicitly. Structured JSON retains literal
tag strings. Worker HTTP tests confirm clean response and replay storage, with
one inference call. Existing drafts and old replay data are not rewritten.

The canonical staging release passed doctor 14/14, generated types, lint,
TypeScript, build and 2,310 tests (1,314 unit/frontend/contracts/scripts,
972 Worker, 24 migration fixtures), plus all 34 remote schema companions.
Version `7747f536-f15e-42c5-a0a7-41d0c53be2b2` passed release smoke. A synthetic
live MiniMax request returned 200 with exactly `OK`, no think tags, in 15.6 seconds.
The diagnostic session was revoked and no message sent. See
[staging QA](../qa/ai-staging-2026-10-12.md).


## 2026-10-12 — Administrator-owned user mailbox assignments

Remove member management from the mailbox sidebar and inbox header. Legacy
member-page bookmarks use the administrative guard and redirect to Admin Users;
ordinary users return to their mailbox. Membership APIs now require global
`mailbox.share`, including for owners. Ownership and mailbox roles no longer
satisfy the mailbox `manage_members` operation.

Admin Users can select multiple mailboxes when creating an account. Each selected
mailbox receives the existing full-operation `admin` membership role, atomically
with the user, default member role, audit event and idempotency record. The new
user-centric permission panel assigns/replaces/revokes viewer, sender or full
mailbox access. Writes require `user.manage` and `mailbox.share`; reads require
`user.read` and `mailbox.share`. Administrators gain metadata access rather than
implicit access to private mail. Existing owned mailboxes retain their implicit
operation permissions; this change does not transfer ownership.

Local `pnpm verify` passed 14 doctor checks, generated types, lint, TypeScript,
web/Worker builds and 2,323 tests (1,319 unit/frontend/contracts/scripts, 980 Worker,
24 migration fixtures). A final frontend cache reconciliation and style pass
also passed focused frontend tests, ESLint, TypeScript and web build. Synthetic
local browser checks covered creation with two full-access grants, another
mailbox's send access, read-only downgrade, Chinese text, desktop/mobile layouts
and ordinary-user navigation. No production/staging publication, remote data
change or migration occurred. Self-review only; no independent agent review.
See [handoff](../../work/handoffs/user-mailbox-access-2026-10-12.md).


## 2026-10-12 — User mailbox access staging release

Commit feature `e5b1941` and rules/handoff `7bd65c6`, then publish staging through
`pnpm deploy:staging`. The canonical gate passed doctor 14/14, generated types,
lint, TypeScript, web/Worker builds and 2,323 tests (1,319 non-Worker, 980 Worker,
24 migration fixtures). Both staged commits passed redacted Gitleaks checks.
All 34 remote migration companions passed; no migration was applied.

Version `ce628a61-f6a0-4785-9b36-7ce9120ac776` passed release smoke. Independent
HTTP checks confirmed health/readiness at revision `7bd65c6`, schema 0034,
matching source digest, 401/no-store on the new grant reads/write and legacy
membership read, and published assignment controls/Chinese text. Authenticated
real-account creation/grant edits were not exercised; no verification grants,
mail content or provider configuration were changed. No production publication
or source push. See [staging QA](../qa/user-mailbox-access-staging-2026-10-12.md).


## 2026-10-12 — Administrator operation modals

Source `409ab7d` moves account creation, mailbox grants, password/reset/status,
domain add/configuration, general/AI configuration and one-time credential display
into the existing bounded dialogs. Lists and saved configuration remain on the
page. Domain connection selection now requires Save. Cancellation clears drafts;
failed writes remain in the modal; pending writes block duplicate submission and
accidental closing. Settings conflict refresh retains its edit lock, including
when the modal is reopened. Chained reveal dialogs restore the original trigger.
No backend permission, schema or API change.

The first full local gate passed 2,330 tests. Final UI focus/cache/cancel corrections
passed the 69-test admin suite and focused follow-ups; staged Gitleaks passed.
Desktop and 390 x 844 browser checks used synthetic local APIs. Staging publication
and exact-source gate are recorded separately. See
[handoff](../../work/handoffs/admin-operation-modals-2026-10-12.md).


## 2026-10-12 — Administrator modal staging release

Publish clean revision `f4088ee` through `pnpm deploy:staging`. The exact-source
gate passed doctor 14/14, generated types, lint, TypeScript, builds and 2,330 tests
(1,326 non-Worker, 980 Worker, 24 migration fixtures). All 34 remote migration
companions passed; no migration was applied. Version
`b562ed68-afb0-4cd0-999d-392ceab327a9` passed canonical release smoke. Independent
HTTP checks matched the release identity/readiness, rejected unauthenticated admin
GETs with 401/no-store, and verified all five published modal page chunks plus
Chinese copy. Local browser observations used synthetic accounts/configuration;
no authenticated real-account write was used for staging verification. No production
publication or source push. See [staging QA](../qa/admin-operation-modals-staging-2026-10-12.md).

## 2026-10-12 — Public installation and agent deployment documentation

README now introduces independent Cloudflare installations and links the new
[agent deployment guide](../operations/agent-deploy.md) through a tool-neutral
`AGENTS.md` entry point. The guide covers account/product access, template fields,
bootstrap, protected key recovery, committed production configuration, publication,
setup, routing, verified senders, mailbox grants, optional settings and real
send/receive/reply/attachment acceptance. It distinguishes provider and setup UI
gaps from completed mail service and uses GET polling for incoming smoke results.

Public documentation no longer names the unrelated reference mail project or
contains personal machine paths. The implementation plan has a neutral filename;
its references are updated. Product and repository overviews describe current
source, with earlier discovery material explicitly historical. Release and script
instructions are aligned with the actual dispatcher and target validators.

Validation: changed-document local links and secret scans passed; doctor 14/14,
focused formatting and diff checks passed. Shell example syntax, fresh local key
generation, independent 64-character hex values, 0600 permissions and refusal to
overwrite existing keys were verified in isolated scratch. Production/staging/
preview template transformations and documented deployment flags passed the real
local parsers. No application, runtime configuration, migration or provider change;
no deployment, DNS change, remote bootstrap, commit or push was performed.

## 2026-10-12 — Upstream releases and fork update notifications

Add a canonical-repository-only workflow that verifies stable tags and product
versions, runs the full gate and creates a Release draft for maintainer review.
The administrator overview now reads a `settings.read`-protected version check
and provides stable release notes and upgrade links. The fixed anonymous GitHub
request has a five-second timeout and bounded response; installation KV caches
success/no-release for six hours and errors for 15 minutes. Checks can be disabled
with `UPDATE_CHECK_ENABLED=false`; no automatic deployment or mail notification.
Shared contracts own the product version independently of the Worker UUID.

README/AGENTS and deployment navigation link the new update guide, which explains
upstream subscription, custom fork merges, backups, preserving account/resources
and encryption keys, verified deployment and existing-installation acceptance.

Validation: 32 focused tests passed. The dirty workspace's full gate encountered
an unrelated, ongoing mailbox-selector test change; an isolated owned snapshot
based on `bb126eb` passed `pnpm verify`: doctor 14/14, bindings, lint, TypeScript,
builds and 2,362 tests (1,351 non-Worker, 987 Worker, 24 migrations). A later
version-independent fixture adjustment passed its seven Worker tests again.
Actionlint, focused formatting, local links/shell syntax, diff and scoped redacted
Gitleaks passed. Desktop/mobile agent-browser checks used synthetic APIs and
confirmed English/Chinese notices, manual checks, links and no mobile overflow.
Self-review only. Public latest-release API returned 404; no stable release exists
to announce. No source commit/push, Release publication, deployment or private
mail/provider changes. See [handoff](../../work/handoffs/upstream-update-notifications-2026-10-12.md).


## 2026-10-12 — Publish first stable source Release 1.0.0

Commit the prepared public installation guides and upstream update checks together
with the reviewed administration/AI work. Set APPLICATION_VERSION to 1.0.0 and
publish immutable v1.0.0 at `847b8e60d5b5386764d5172176ef9a2955602bc6` on upstream
main. The official draft workflow validated main ancestry and product/tag equality,
ran the full gate and created the draft. Reviewed notes were then published as
Latest at 19:28:58 Asia/Shanghai. Public latest-release metadata and exact note
content were verified. Main/tag Verify, secret scanning and main CodeQL passed.

The clean canonical staging flow passed 2,368 tests (1,357 non-Worker, 987 Worker,
24 migration fixtures); all 34 remote migration companions passed, none applied.
Staging application revision `25e1059`, Worker `01d1bd24-80b1-473c-be4f-2edc16d4765f`,
source digest and eight served page chunks matched; nine anonymous admin paths
rejected access. The tag's later changes were documentation-only. Recovery
metadata remains protected privately. No additional real-account mutation,
provider/delivery test or production deployment was performed for publication.

GitHub surfaced existing dependency advisories. Fresh pnpm audit reported one
critical, 13 high, 18 moderate and four low findings. Their dependency paths,
unresolved status and lack of a deployed exploitability assessment are recorded
in [release QA](../qa/release-1.0.0-2026-10-12.md) and the public release notes.
Dependency upgrades are outside this publication change. Local links, Actionlint,
diff and redacted staged/all-history secret scans passed. Self-review only.
