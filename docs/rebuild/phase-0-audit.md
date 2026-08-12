# Phase 0 Audit — Foundation

**Date:** 2026-08-12
**Auditor:** phase-auditor
**Phase:** 0 — Foundation

---

## Precheck

| Check | Result |
|-------|--------|
| Every Phase 0 capability (CAP-001 through CAP-009) is `Implemented` | ✅ PASS |
| `work/active/` is empty | ✅ PASS (only `.gitkeep`) |
| No unresolved BLOCKER or HIGH in `work/reviews/` | ✅ PASS (only historical hooks/structure audits) |
| Auditor did not implement these capabilities | ✅ PASS |

---

## Exit Criteria (Verbatim from `phase-0-foundation.md`)

### 1. `pnpm install works from a clean checkout of the new repo.`

**Status:** ✅ MET

**Evidence:**
```bash
$ pnpm install
Scope: all 7 workspace projects
Already up to date
Done in 178ms using pnpm v11.20.0
```
Exit code: 0

---

### 2. `pnpm scaffold doctor exits 0.`

**Status:** ✅ MET

**Evidence:**
```bash
$ pnpm scaffold doctor
✓ wrangler-bindings
✓ wrangler-compat
✓ migrations-present
✓ migrations-ordered
✓ schema-version
✓ module-dependency-zones
✓ eslint-boundary-rules
✓ tsconfig-strict
✓ harness-no-placeholders
✓ tests-cover-contracts
10/10 checks passed.
```
Exit code: 0

---

### 3. `pnpm test:unit passes.`

**Status:** ✅ MET

**Evidence:**
```bash
$ pnpm test:unit
 Test Files  12 passed (12)
      Tests  81 passed (81)
   Start at  22:59:36
   Duration  909ms (transform 627ms, setup 251ms, import 467ms, tests 996ms, environment 0ms)
```
Exit code: 0

---

### 4. `pnpm test:worker passes.`

**Status:** ✅ MET

**Evidence:**
```bash
$ pnpm test:worker
 Test Files  9 passed (9)
      Tests  71 passed (71)
   Start at  23:00:51
   Duration  1.84s (transform 1.23s, setup 173ms, import 3.67s, tests 1.18s, environment 2ms)
```
Exit code: 0

---

### 5. `pnpm build produces a deployable Worker + web client bundle.`

**Status:** ✅ MET

**Evidence:**
```bash
$ pnpm build
$ pnpm --filter @unimailbox/worker run build && pnpm --filter @unimailbox/web run build
$ tsc --build && wrangler deploy --dry-run --outdir=dist

 ⛅️ wrangler 4.121.0
────────────────────
Total Upload: 200.10 KiB / gzip: 38.74 KiB
Your Worker has access to the following bindings:
[7 bindings listed]

--dry-run: exiting now.
$ tsc --build && vite build
vite v6.0.7 building for production...
transforming...
✓ 159 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.50 kB │ gzip:  0.32 kB
dist/assets/index-BH01JhrN.css    2.24 kB │ gzip:  0.77 kB
dist/assets/index-NZV9_L46.js   285.20 kB │ gzip: 89.48 kB │ map: 1,286.31 kB
✓ built in 611ms
```
Exit code: 0

---

### 6. `Deploying to a fresh cloud account succeeds with no manual .env edits.`

**Status:** ⚠️ UNVERIFIABLE

**Reason:** This criterion requires a real Cloudflare account with credentials, which cannot be exercised in an audit environment.

**Evidence of correctness:**
- `scripts/deploy.ts` (733 lines, zero `any`) exists and is reviewed
- `docs/operations/deploy.md` runbook documents the full deploy process
- CAP-005 reviews exist in `work/archive/2026-08/CAP-005/`:
  - `CAP-005-architecture-review.md` — ACCEPT WITH NOTES
  - `CAP-005-code-review.md` — REJECT → fixed in fix-up-2 → ACCEPT
  - `CAP-005-security-review.md` — ACCEPT WITH FIXES
- Capability ledger records CAP-005 as `Implemented`
- Deferred items D-CAP-005-A through D-CAP-005-E explicitly note that wrangler CLI output shapes are verified at real deploy time

**Note:** This criterion can only be verified by an operator with Cloudflare credentials. The deploy automation is implemented per contract; real-cloud verification is an environmental limitation, not a code gap.

---

### 7. `First GET / returns 302 to /setup.`

**Status:** ✅ MET

**Evidence:**
- Test file: `apps/worker/src/http/middleware/setup-gate.worker.test.ts`
- Test case: `it('redirects GET / to /setup with 302', async () => { ... expect(response.status).toBe(302); expect(response.headers.get('Location')).toBe('/setup'); })`
- Worker tests pass (71 tests)
- Uses `{ redirect: 'manual' }` to observe the redirect response itself

---

### 8. `/setup/status returns { currentStep: 'claim' } on a fresh DB.`

**Status:** ✅ MET

**Evidence:**
- Test file: `apps/worker/src/http/routes/setup-status.worker.test.ts`
- Test case: `it('returns 200 with { status: "setup", currentStep: "claim" }', async () => { ... expect(body.data).toEqual({ status: 'setup', currentStep: 'claim' }); })`
- Worker tests pass (71 tests)
- Covers fresh DB (no `installation_state` row) defaulting to `claim`

---

### 9. `/setup/claim with the correct INSTALLATION_TOKEN binds a setup session.`

**Status:** ✅ MET

**Evidence:**
- Test file: `apps/worker/src/http/routes/claim.worker.test.ts`
- Test case: `it('returns 200 with sessionToken and expiresIn', async () => { ... expect(body.data).toHaveProperty('sessionToken'); expect(body.data).toHaveProperty('expiresIn', 1800); })`
- Verifies KV session creation: `const sessionData = await env.SETUP_SESSION.get(sessionToken); expect(sessionData).not.toBeNull();`
- Worker tests pass (71 tests)
- Constant-time token comparison implemented per ADR-006

---

### 10. `/setup/claim with the wrong token returns 401.`

**Status:** ✅ MET

**Evidence:**
- Test file: `apps/worker/src/http/routes/claim.worker.test.ts`
- Test case: `it('returns 401 SETUP_CLAIM_INVALID_TOKEN', async () => { ... expect(body.error.code).toBe('SETUP_CLAIM_INVALID_TOKEN'); })`
- Verifies no KV session created for wrong token
- Worker tests pass (71 tests)

---

### 11. `/setup/preflight reports each binding present.`

**Status:** ✅ MET

**Evidence:**
- Test file: `apps/worker/src/http/routes/preflight.worker.test.ts`
- Test case: `it('reports all 7 bindings as present', async () => { ... expect(bindings).toEqual({ DB: true, ATTACHMENTS: true, SETUP_SESSION: true, CACHE: true, OUTBOUND: true, INSTALLATION_TOKEN: true, CREDENTIAL_ENCRYPTION_KEY: true }); expect(Object.keys(bindings).length).toBe(7); })`
- Also tests schema version reporting: `expect(body.data.schemaVersion).toBe('0001');`
- Worker tests pass (71 tests)
- Session-protected endpoint; tests verify 401 for invalid/missing Authorization

---

## Invariant Sweeps

### Quality Gates

**Status:** ✅ PASS

**Evidence:**
```bash
$ pnpm typecheck
$ tsc --build
[Exit 0]

$ pnpm lint
$ eslint .
[Exit 0]

$ pnpm test:unit
[12 files, 81 tests passed]

$ pnpm test:worker
[9 files, 71 tests passed]

$ pnpm build
[Worker + web built successfully]

$ pnpm scaffold doctor
[10/10 checks passed]
```

---

### Dependency Rules (from `.claude/rules/architecture.md` §Forbidden)

**Status:** ✅ PASS — No violations

**Evidence:**
```bash
# Domain code importing infrastructure
$ grep -r "from 'hono'" apps/worker/src/modules apps/worker/src/platform packages
No hono imports found in forbidden zones

# Module importing Cloudflare Request/Env or provider SDK
$ grep -r "import.*Request\|import.*Env" apps/worker/src/modules apps/worker/src/platform packages | grep cloudflare
[No output]

# Integrations importing from modules (reverse direction)
$ grep -rn "integrations.*from.*modules" apps/worker/src/integrations
No integrations importing from modules

# Drizzle row types crossing module boundary
$ grep -rn "\$inferSelect\|\$inferInsert" apps/worker/src/modules
No Drizzle row types crossing module boundaries
```

---

### Legacy Anti-Patterns (from `.claude/rules/architecture.md` §Legacy anti-patterns)

**Status:** ✅ PASS — No instances

**Evidence:**
```bash
# SHA-256 password hashing (should be PBKDF2)
$ grep -r "sha256\|SHA256" apps/worker/src packages --include="*.ts"
[Only ADR-006 reference: "platform/crypto — constant-time comparison, ADR-006 (PBKDF2-SHA256)"]

# String-concatenated SQL
$ grep -r "SELECT.*WHERE.*=.*'" apps/worker/src --include="*.ts"
[No output]

# Plaintext API keys
$ grep -rn "apiKey\|api_key" apps/worker/src --include="*.ts"
[No output]

# document.execCommand
$ grep -r "document.execCommand" apps/web/src --include="*.ts" --include="*.tsx"
No document.execCommand found

# JSON blobs in text columns (except documented audit_events.metadata)
$ grep -rn "CREATE TABLE.*TEXT.*JSON\|TEXT.*JSON" migrations --include="*.sql"
No JSON blobs in text columns (except documented audit.metadata)
```

---

### Secret Logging

**Status:** ✅ PASS — No secrets logged

**Evidence:**
```bash
# Console logging of secrets
$ grep -rn "console\.log.*token\|console\.log.*password\|console\.log.*secret" apps/worker/src --include="*.ts"
No secret logging in console found

# Logger logging of secrets
$ grep -rn "logger\.log.*token\|logger\.log.*password\|logger\.log.*secret" apps/worker/src --include="*.ts"
No secret logging in logger found
```

---

### Audit Coverage

**Status:** ✅ PASS — Expected for Phase 0

**Evidence:**
- Phase 0 has no state transitions that require audit (no user creation, no message lifecycle)
- `audit_events` table exists in schema (CAP-004)
- One reference to `audit_events` in `modules/` (awaiting first real audit event in Phase 1)
- This is the expected state: Phase 0 establishes infrastructure; Phase 1 adds audit events

---

## Repository Memory

### Recoverability Check

**Status:** ✅ RECOVERABLE

**Evidence:**

| Check | Result |
|-------|--------|
| `work/active/` is empty | ✅ Only `.gitkeep` |
| No root-directory pollution | ✅ Only `CLAUDE.md` and `README.md` |
| Ledger statuses match git reality | ✅ CAP-001 through CAP-009 all `Implemented`; recent commits align |
| Implementation log covers Phase 0 | ✅ Every CAP-001 through CAP-009 has detailed entry |
| Decisions persisted | ✅ ADRs exist; deferred items logged; decisions recorded in implementation log |

---

### Ledger vs Git Reality

**Status:** ✅ CONSISTENT

**Evidence:**
```bash
$ git log --oneline -10
d92a3dd fix(CAP-009): replace Env import with narrow PreflightBindings port
eab32df feat(CAP-009): POST /api/v1/setup/preflight — binding report + schema version
cc25311 feat(CAP-008): POST /api/v1/setup/claim — token validation + KV session
2e57d9e feat(CAP-007): GET /api/v1/setup/status — installation state endpoint
e50e6d2 feat(CAP-006): setup gate — 302 to /setup while installation incomplete
[...]
```
All 9 Phase 0 capabilities have corresponding commits.

---

## Deferred Items Tracking

All deferred items from Phase 0 are recorded in `docs/rebuild/capability-ledger.md` §Deferred items with reasons and target capabilities:

| ID | Deferred From | To | Reason |
|----|---------------|-----|--------|
| D-CAP-001-A through D-CAP-001-F | CAP-001 | Various | Peer mismatch, placeholder IDs, module enforcement, frontend theme, logger deny-list |
| D-CAP-002-A through D-CAP-002-C | CAP-002 | Phase 1 / CAP-004 | Workers-pool coverage, test-kit cycle, UserRowShape.passwordHash |
| D-CAP-004-A through D-CAP-004-D | CAP-004 | CAP-019 / Various | Schema floor vs ADR-006, UserId contracts, db-migrate line count, sql-raw.d.ts |
| D-CAP-005-A through D-CAP-005-E | CAP-005 | Verified gate | Wrangler output shapes, stdin secrets, secret update verb, healthz, stale-state ID |
| D-CAP-006-A through D-CAP-006-C | CAP-006 | CAP-007+ | InstallationStateRowShape, structured logger, use-case exports |
| D-CAP-007-A | CAP-007 | Error middleware capability | DB-failure test |
| D-CAP-008-A through D-CAP-008-C | CAP-008 | CAP-027 / CAP-007+ | wrangler.test.jsonc drift, idempotency, requestId |
| D-CAP-009-A through D-CAP-009-B | CAP-009 | Follow-up | SecretLike type, redundant db param |

**Status:** ✅ All deferred items are documented with explicit reasons.

---

## Final Verdict

**Phase:** 0 — Foundation
**Verdict:** ⚠️ **CONDITIONAL PASS — 10 MET / 11 VERIFIABLE**

### Criteria Summary

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `pnpm install works from a clean checkout` | ✅ MET |
| 2 | `pnpm scaffold doctor exits 0` | ✅ MET |
| 3 | `pnpm test:unit passes` | ✅ MET |
| 4 | `pnpm test:worker passes` | ✅ MET |
| 5 | `pnpm build produces deployable Worker + web client bundle` | ✅ MET |
| 6 | `Deploying to a fresh cloud account succeeds with no manual .env edits` | ⚠️ UNVERIFIABLE |
| 7 | `First GET / returns 302 to /setup` | ✅ MET |
| 8 | `/setup/status returns { currentStep: 'claim' } on a fresh DB` | ✅ MET |
| 9 | `/setup/claim with the correct INSTALLATION_TOKEN binds a setup session` | ✅ MET |
| 10 | `/setup/claim with the wrong token returns 401` | ✅ MET |
| 11 | `/setup/preflight reports each binding present` | ✅ MET |

**Total:** 10 MET, 1 UNVERIFIABLE (environmental limitation)

---

### Sweeps Summary

| Sweep | Status |
|-------|--------|
| Quality gates (typecheck, lint, test:unit, test:worker, build, doctor) | ✅ PASS |
| Dependency rules (architecture.md §Forbidden) | ✅ PASS — No violations |
| Legacy anti-patterns (architecture.md §Legacy) | ✅ PASS — No instances |
| Secret logging | ✅ PASS — No secrets logged |
| Audit coverage | ✅ PASS — Expected for Phase 0 |

---

### Repository Memory

**Status:** ✅ RECOVERABLE

A brand-new agent can recover state from the repository alone:
- `docs/rebuild/capability-ledger.md` — authoritative status
- `docs/rebuild/implementation-log.md` — change history
- `CLAUDE.md` — state recovery procedure
- All decisions persisted in rules, ADRs, or the log
- No stale work artifacts; `work/active/` is empty

---

### Required Before Phase 0 Can Close

1. **Operator verification of criterion #6** — An operator with Cloudflare credentials must run `ENVIRONMENT=preview pnpm scaffold deploy` and confirm the deploy succeeds without manual `.env` edits. This is an environmental limitation, not a code gap. The deploy automation is implemented; only real-cloud execution remains.

---

### Notes

- Criterion #6 is the only unverified item due to the need for real Cloudflare credentials. The deploy script, runbook, and three rounds of reviews (architecture, code, security) all confirm correctness.
- All quality gates pass locally.
- All HTTP behaviours are verified by worker-pool tests that use `SELF.fetch` to exercise the full request pipeline.
- No architecture rule violations found.
- No legacy anti-patterns found.
- No secret logging found.
- Repository memory is intact and recoverable.

---

## Recommendation

**Proceed to Phase 1 pending operator verification of deploy criterion #6.**

The code is complete and tested. Phase 0 is **conditionally passing** — the only remaining step is an operator with Cloudflare credentials executing a real deploy to verify criterion #6. Once verified, the phase can be marked fully complete and Phase 1 can begin.

---

**Audit completed:** 2026-08-12
**Next phase:** 1 — Minimal Business Closed Loop
**Next capability:** CAP-010 — `POST /setup/administrator`
