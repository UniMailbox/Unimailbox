# Batch 5 + Batch 6 plan — CAP-042 AC 20-23

**Status:** preparatory, awaiting Batch 4 (AC 17-19) to land.
**Created:** 2026-08-23.
**Owner:** orchestrator (this is NOT an implementer contract).

This file is the orchestrator's working notes for the next two batches. They
become formal `work/active/CAP-NNN/task.md` contracts at dispatch time.

---

## Batch 5 — Browser shell + CAP-041 follow-ups (AC 20-22)

**Goal:** The single React client (apps/web/) implements the auth shell that
exercises the production routes wired in Batches 2-4.

### Reading list (for the implementer contract)

- work/active/CAP-042-better-auth-shell/task.md (the master contract — AC 20-22)
- work/active/CAP-042-better-auth-shell/spike-evidence.md (cookie/origin decisions)
- apps/web/src/app/router.tsx (existing TanStack Router setup)
- apps/web/src/infrastructure/api/{client,errors,retry}.ts (existing ApiClient)
- apps/web/src/features/setup/setup-session-store.ts (existing in-memory token pattern — model after this for auth session)
- apps/web/src/features/setup/steps/* (pattern for step components)
- apps/web/src/test-utils.tsx (existing renderStep + mountAppRouter)
- work/archive/2026-08/CAP-041/task.md (CAP-041 setup web patterns — direct precedent)
- .claude/rules/coding.md §Structure / §Language and stack

### AC 20 — login, registration, logout, session recovery, authorized mailbox nav

Build under `apps/web/src/features/auth/`:
- `auth-session-store.ts` (Zustand, in-memory only — never `persist` middleware)
- `auth-queries.ts` (TanStack Query hooks for sign-in / sign-up / sign-out / get-session)
- `LoginPage.tsx` + `RegisterPage.tsx` + `LogoutButton.tsx` (form components, react-hook-form + zod)
- Loading/error/unauthorized/expired-session states (shared patterns from setup)
- Mailbox shell at `apps/web/src/features/mailbox/MailboxShell.tsx` — protected route component that redirects to /login if session is missing
- New routes: `/login`, `/register`, `/mailbox` (and `/mailbox/$mailboxId` if/when mailbox IDs exist; placeholder is fine)

### AC 21 — HttpOnly cookies, no tokens in browser storage

R-SECRET-003 / R-AUTH-007 enforcement at the client:
- Sign-in form posts to `/api/v1/auth/better/sign-in/email` (or legacy `/api/v1/auth/login` in `legacy` mode); browser receives `Set-Cookie` from Better Auth or legacy token in JSON response (in dual/legacy mode)
- **No `localStorage.setItem`, `sessionStorage.setItem`, or `IndexedDB.put` for any access/refresh/session token.** Assert via a unit test that walks the source tree.
- Tests: `auth-session-storage.test.ts` greps the build output to assert no `localStorage`/`sessionStorage`/`indexedDB` token write paths.

### AC 22 — D-CAP-041-1 and D-CAP-041-9 closure

D-CAP-041-1 = cache-backed router loading (the loader fetches via cache; on
hit, render immediately).
D-CAP-041-9 = at least one real router-context test before mailbox shell reuses.

Implementer needs to:
- Read `work/archive/2026-08/CAP-041/task.md` §Decisions D2 / D-CAP-041-A (ApiClient useMemo at root)
- Add at least one router-context test in `apps/web/src/app/router.test.tsx` (or similar) that mounts the router and asserts the beforeLoad redirect for an authenticated route when no session exists
- Use the same `mountAppRouter` test helper from CAP-041

### File ownership

WRITE (apps/web/ only — no backend changes for Batch 5):
- apps/web/src/features/auth/** (NEW)
- apps/web/src/features/mailbox/** (NEW)
- apps/web/src/app/router.tsx (extend with new routes)
- apps/web/src/infrastructure/api/client-provider.tsx (extend if needed)
- apps/web/src/App.tsx (wire QueryClient + ApiClient once)
- apps/web/src/test-utils.tsx (extend)
- apps/web/src/app/router.test.tsx (NEW)

DO NOT TOUCH:
- apps/worker/**
- packages/contracts/** (closed enum additions are ADR territory)
- migrations/**

---

## Batch 6 — Local cutover + rollback proof (AC 23)

**Goal:** `AUTH_PROVIDER=legacy|dual|better-auth` is testable end-to-end on a
local D1 binding; switching the value re-validates the entire auth surface
without a migration or restart.

### Reading list

- work/active/CAP-042-better-auth-shell/task.md (AC 23)
- apps/worker/src/platform/config.ts (parseAuthProvider closed enum)
- apps/worker/src/platform/env.ts (AUTH_PROVIDER typing)
- apps/worker/src/http/middleware/authn.ts (lines 140-170 — current cookie resolution + conflict detection)
- apps/worker/src/integrations/better-auth/factory.ts (Better Auth instance creation, gated by `authProvider`)
- apps/worker/src/http/routes/better-auth.ts (line 50 — config-gated mount)
- apps/worker/wrangler.jsonc + wrangler.test.jsonc (binding shape)
- apps/worker/scripts/doctor.ts (parity checks)

### What the implementer must do

The current auth surface already accepts both Bearer (legacy) and Better Auth
cookie. The cutover/rollback test must prove each `AUTH_PROVIDER` value's
behaviour independently:

- **`legacy` mode**: Better Auth cookie is silently ignored (or rejected with
  401). Bearer token via Authorization header works. Sign-in via
  `/api/v1/auth/login` works; `/api/v1/auth/better/sign-in/email` returns 401
  or 404.
- **`dual` mode**: Both paths work. Conflict detection (AC 14) still runs
  when both principals resolve.
- **`better-auth` mode**: Bearer token is rejected (or ignored). Better Auth
  cookie is the only valid principal. Sign-in via legacy `/api/v1/auth/login`
  returns 401.

Each mode needs at least one positive and one negative test.

**Rollback proof** (critical): a test that exercises `dual → legacy → dual`
without restarting the Worker. The test must:
1. Set `AUTH_PROVIDER = 'dual'` (env override), run a request that signs in
   via Better Auth cookie, assert 200.
2. Set `AUTH_PROVIDER = 'legacy'` (env override), run the SAME request, assert
   the Better Auth cookie is no longer accepted (or a conflicting Bearer is
   required).
3. Set `AUTH_PROVIDER = 'dual'` again, assert the Better Auth cookie is
   accepted again.

This proves the additive schema holds through cutover and rollback without a
migration. Better Auth's `auth_accounts` / `auth_sessions` rows survive all
three phases; legacy `users.password_*` rows survive all three phases.

### File ownership

WRITE:
- apps/worker/src/http/middleware/authn.worker.test.ts (extend: cutover matrix)
- apps/worker/src/http/routes/better-auth.worker.test.ts (extend: mount gating)
- apps/worker/src/integrations/better-auth/factory.ts (only if env-driven
  re-creation is needed; otherwise leave untouched — `c.var.config` is
  per-request, so cutover is free)
- apps/worker/wrangler.test.jsonc (extend: per-test `AUTH_PROVIDER` override
  if needed; existing test config may already support this via env injection)

DO NOT TOUCH:
- migrations/**
- packages/contracts/**
- apps/web/** (frontend cutover is a Batch 7 concern)

---

## Cross-batch constraints

These apply to both Batch 5 and Batch 6:

- **No backend drift.** Batch 5 is pure client. Batch 6 only changes authn /
  factory if the existing per-request `c.var.config` plumbing doesn't already
  cover the cutover test (it should — see `http/middleware/config.ts`).
- **No R-AUTH rule relaxation.** The factory's `requireEmailVerification:
  false` (Batch 2) is the explicit R-AUTH-001 stop condition; do not flip it
  to `true` without an approved deterministic sender contract.
- **No new closed-enum values.** `AUTH_PROVIDER` stays `legacy|dual|better-auth`.
- **No new migrations.** The additive schema (0014 + 0015) is the cutover
  surface; Batch 6's rollback proof must NOT require a migration to roll back
  to legacy.

---

## Deferred — Batch 7

AC 24-25 are gate-passing and review-coordination work owned by the
orchestrator, not delegated to an implementer. After Batches 4-6 land:

- Run all six gates
- Coordinate 5-way parallel review (architecture + code + QA + security +
  frontend)
- Archive work/active/ → work/archive/2026-08/CAP-042/
- Update capability-ledger.md and implementation-log.md
- Final commit at capability boundary

---

**End of plan.**
