# CAP-044 — Slice 3 review record (five-way, 2026-08-24)

Scope reviewed: the Slice 3 tree — `GET /api/v1/admin/users` (identity-owned repository,
`requirePermission('user.read')`, five-column credential-excluding SELECT, keyset cursor on
surface `'admin-users'`), the users/connections/webhook-events web pages, the
`AppNav` admin probe (D-CAP-044-K), the cursor-payload promotion into contracts, the full
AC 22 styling pass, and the admin section landing/router wiring. All five reviewers
received the same brief, the task contract, and the review rules; none wrote the code.

## Verdicts

| Reviewer | Verdict | B/H/M/L |
|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | 0/0/1/6 |
| code | ACCEPT-WITH-FOLLOWUPS | 0/1/2/6 |
| security | ACCEPT-WITH-FOLLOWUPS | 0/0/2/6 |
| frontend | ACCEPT-WITH-FOLLOWUPS | 0/0/2/5 |
| qa | ACCEPT-WITH-FOLLOWUPS | 0/0/3/6 — ACs 15–23 all PASS; gates re-run with zero baseline divergence |

## The one HIGH

**Cross-user admin-data cache retention after sign-out** (code H1; independently found as
security M1). `admin-queries.ts:96-99` documents that sign-out does not clear admin cache
keys and mitigates the hazard for the *probe* only (userId in key). Shared workstation:
admin A loads `/admin/users` (cached under `['admin','users']`), signs out (SPA mutation —
only the session entry is nulled, no reload), member B signs in and opens `/admin/users` by
URL. B's mount serves A's cached rows instantly; the background refetch 403s; the data-first
render contract + `retry: false` deliberately keep the rows mounted under the error banner —
B reads A-sourced personnel data (emails, display names, statuses) persistently. Identical
on connections, webhook-events, and the Slice 2 audit page. No server-side authz bypass (the
data was legitimately fetched by A in this browser), hence HIGH not BLOCKER.

**Disposition: fix pass criterion (a)** — userId-scoped admin data keys, the probe
precedent applied to the four data queries. Sign-out sweep rejected (enumerates
session-transition events; misses cookie-expiry-then-new-sign-in). The CAP-043 mailbox
twin is recorded as systemic deferred row D-CAP-044-O, not silently absorbed.

## Findings → dispositions

| Finding (reviewer) | Disposition |
|---|---|
| Cross-user admin cache retention (code H1 ≡ security M1) | **Fix (a)** — userId-scoped admin data keys |
| Offline-paused false empty on 4 admin pages (frontend M2) | **Fix (b)** — `isPending` gate, all four pages |
| Loading-state branches untested (QA M1) | **Fix (b)** — never-resolving-resolver test per page |
| Probe remount refetch / 403-per-navigation (code M1) | **Fix (c)** — `retryOnMount: false` + remount test |
| Probe not session-stable past gcTime (frontend L1) | **Fix (c)** — `gcTime: Infinity` |
| Probe comment falsehoods ×2 (arch L4 ≡ security L7; code M1) | **Fix (c)** — comments rewritten per ruling 6 |
| `USER_ROW_INVALID` → generic `INTERNAL` (code M2, QA M2, security L4 vs arch L1) | **Fix (d)** — registry grant; ruling 2 overrules accept-as-is |
| Inbox unread divider CSS wrong in mixed lists (frontend M1) | **Fix (e)** — one-sided boundaries |
| Missing `-disabled` status variant (code L4 ≡ QA L6) | **Fix (e)** |
| Reveal secret in MutationCache past unmount (frontend L2, code L1, security L8) | **Fix (f)** — `gcTime: 0` + comment |
| Stale reveal error during pending retry (frontend L3) | **Fix (f)** |
| Cancel-fires-no-POST untested (frontend L5a) | **Fix (f)** |
| Admin-case header link untested in situ (frontend L5b) | **Fix (f)** |
| D-CAP-044-L messages INVALID_CURSOR replay + false comments (code L6) | **Fix (g)** — folded in per ruling 5; closes the row |
| Unpinned extra-get-session count (QA L5) | **Fix (g)** — count assertion |
| Leak regex misses `password_salt`/`_algorithm`/`_iterations` (security L3) | **Fix (h)** |
| Duplicated near-empty assertions (code L5) | **Fix (h)** |
| Spy-scope comment overclaims (code L3 ≡ QA L2) | **Fix (f)** — comment states actual swept set |
| Local zod schemas outside contracts (arch M1 ≡ QA M3 ≡ security L5) | **Deferred D-CAP-044-P** — folded with legacy-lists conversion (ruling 3) |
| Reveal POST missing `requireIdempotencyKey` (security M2, pre-existing CAP-040) | **Deferred D-CAP-044-Q** |
| Users keyset scan without `created_at` index (security L6 ≡ arch L2 ≡ QA L4) | **Deferred D-CAP-044-R** — only when measurable |
| Cross-surface matrix 4-of-6 cells (QA L1) | **Deferred D-CAP-044-S** |
| Onboarding reads `users` directly (arch L6, pre-existing) | **Deferred D-CAP-044-T** |
| `.strict()` deviation undocumented outside code (arch L3) | Closure duty — implementation-log entry |
| Probe signals `audit.read` only (frontend note) | Accepted; noted on D-CAP-044-K |
| Extra get-session per inbox load (code L2) | Accepted; pinned by fix (g) |
| `ul/li` not a table (QA L3); `components/` → `features/admin` import (arch L5) | Accepted as house-consistent / rule-compliant |
| AlertDialog focus trap (frontend L4) | Inherited CAP-043 H12 deferral; extended to reveal confirm |

## Verified correct (cross-reviewer evidence)

- **Users vertical parity with the audit precedent**: boundary-only null-bound cursor slots
  (hand-verified 5 binds), `ORDER BY created_at DESC, id DESC` with matching predicate,
  exact-limit tail emits non-null cursor + terminal empty page, tie-breaker arm across an
  in-group page edge, tamper → 400, clamp, near-empty edge (architecture, code, QA).
- **Credential exclusion is layered**: five-column SELECT matching the 0001 DDL (password
  columns named-and-excluded), field-by-field mapping (no row spread), `userListItemSchema`
  `.strict()`, recursive `collectKeys` no-secret walk, client-side leak-rejection tests
  (security, QA).
- **Cursor promotion**: `cursorPayloadSchema` + closed `CursorSurface` union exist exactly
  once in the repo (grep-verified); `platform/cursor.ts` is crypto-only; cross-surface
  rejection proven with real-key-signed payloads on all three surfaces as verifiers
  (architecture, QA, code).
- **Reveal flow (R-SECRET-003 amended exception)**: confirm-gated single POST (fresh
  Idempotency-Key per non-GET in the client transport), one-time display with audit note,
  Hide clears, failure renders inside the dialog with rows retained, audit row written
  *before* the secret is returned (fail-safe ordering), five console-method spies +
  full localStorage/sessionStorage value sweep, nothing in any query cache (security,
  frontend, code).
- **Error-before-data defect class clean on all three new pages** (the class that produced
  HIGHs in Slices 1–2): rows retained through failed load-more, background-refetch failure
  pinned via cache seeding, INVALID_CURSOR start-over in both branches, not-authorized one
  request `role="status"` (frontend).
- **AC 22**: automated className cross-check — zero unresolved classes, zero inline
  `style=` props; state variants distinguishable at class level; dark-mode
  warning-collision checked and avoided (frontend, architecture, QA).
- **Gates**: QA's independent full run — doctor 13/13, typecheck 0, lint 0, unit 850/850,
  worker 732/736 (the 4 documented D-CAP-042 failures verified by name), build 0.

## Disagreements resolved by the orchestrator

- **USER_ROW_INVALID**: architecture accept-as-is (path unreachable via CHECK; branch
  untestable) vs code/QA/security grant-now. Ruled fix-now: the registry grant is the Slice
  2 precedent, additive, and cheaper than a permanent deferred row; the untestability stands
  (no new worker test required).
- **Retention fix shape**: code suggested a sign-out sweep in `auth-queries.ts` (outside
  ownership) or userId keys; security suggested userId keys or a sweep. Ruled userId keys —
  structural, inside ownership, matches the probe precedent the file itself documents.
- **Local schemas**: all three finding reviewers defer; the promotion mechanism is folded
  with the legacy-lists conversion so contracts never becomes a second source of truth
  beside a hand-mapped route.

## Outcome

Fix pass dispatched on criteria (a)–(h) of the task contract's "Slice 3 review outcome →
fix pass" section. Rulings 1–7 and deferred rows D-CAP-044-O…T recorded there and carried to
capability closure.
