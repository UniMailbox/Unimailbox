# CAP-044 Slice 2 — consolidated review round (2026-08-24)

Five-way parallel review of the audit-event query slice (enum + seed, query repository,
`GET /api/v1/admin/audit-events`, `/admin` web section + AuditEventsPage). None of the
reviewers wrote the code. The implementation was orchestrator-validated before dispatch
(17-file diff exactly matching the slice-2 ownership row; 12/12 SQL bind slots verified by
hand; all six gates re-run: doctor 13/13 · typecheck/lint/build EXIT=0 · unit 793/793 across
52 files · worker 711/715 with exactly the 4 documented
`D-CAP-042-pre-existing-parallelism` failures, verified by name).

Consolidated verdict: **ACCEPT-WITH-FOLLOWUPS ×5 → orchestrator ruled a fix pass mandatory**
(criteria (a)–(g) in `work/active/CAP-044-compose-reply-admin/task.md` §Slice 2 review
outcome). No BLOCKERs anywhere.

| Reviewer | Verdict | BLOCKER | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 4 |
| code | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 6 |
| security | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 2 | 2 |
| frontend | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 5 |
| QA | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 2 | 5 |

## The two ship-blocking HIGHs

**Architecture H1 — AC 9's "served by the existing indexes" claim is empirically false.**
`audit-query-repository.ts` guards every filter column with `? IS NULL OR …` so one statement
text serves every combination. SQLite picks a plan at prepare time independent of bindings,
and the OR-optimization cannot apply across the un-indexed `? IS NULL` arm: `EXPLAIN QUERY
PLAN` (sqlite3 3.51.0, exact DDL from `migrations/0001_initial.sql:182-196`) shows every
combination — including an actor filter bound non-NULL — as `SCAN audit_events USING INDEX
audit_events_created_idx` + temp B-tree for the ORDER BY tail. Literal-folded per-shape
statements DO select `audit_events_actor_idx` / `audit_events_resource_idx`. `audit_events`
is append-only (written on every state transition, R-AUDIT-001, retained ≥90 days) — the one
unbounded-growth table — and D1 bills rows-read: every audit page view scans the whole trail.
Independently confirmed by QA (M1, same EXPLAIN method). → fix (a); ruled fix-not-reword.

**Frontend H1 — the error state replaces the entire page.** `AuditEventsPage` branches on
`error` before data: an invalid `actorUserId` uuid → dead-end Retry loop (the filter form is
unmounted, so the user cannot correct the value); a failed background refetch after pages
have accumulated wipes every loaded row. Same defect class as Slice 1 fix (c), ruled against
twice now. → fix (e).

## Rulings (orchestrator)

1. **AC 13 nav clause** (code H1 ≡ architecture M2 ≡ QA M2 ≡ frontend M2): unmeetable inside
   Slice 2 — the session descriptor carries no role/permission signal; widening it is an
   orchestrator-level identity/auth decision. Member-side behavior is correct and test-proven
   (one request → not-authorized panel, no crash loop; authorization entirely server-side).
   AC amended; deferred row **D-CAP-044-K**: Slice 3 adds the shared-header Admin entry gated
   by an authenticated probe (`GET /api/v1/admin/audit-events?limit=1`, `retry: false` — 200
   shows, 403 hides). No session-contract widening, no new server surface.
2. **AC 9**: fix via per-combination WHERE composition (messages-module precedent:
   bare equalities per active filter, null-bound slots for the cursor boundary only).
3. **Upgrade-path seed gap** (security M2 ≡ code L6): existing deployments lack `audit.read`
   until the seed re-runs — fails closed. Deferred row **D-CAP-044-N**; CAP-045 asserts the
   fresh preview.
4. **Messages-side INVALID_CURSOR ≥2-page replay** (code M2): `refetch()` replays stored
   pageParams, so a stored chain after `CURSOR_SIGNING_KEY` rotation fails forever under
   Retry. Inherited verbatim from CAP-043's `InboxListPage.tsx:94-99`. Slice 2's copy fixed
   by (e); deferred row **D-CAP-044-L** for the messages surfaces.

## Findings → dispositions

| Finding | Reviewers | Disposition |
|---|---|---|
| Single-statement scan shape (index claim false) | arch H1, QA M1 | fix (a) |
| Error state replaces page / dead-end Retry / rows wiped | frontend H1 | fix (e) |
| `row.action as AuditAction` unvalidated; corrupt row → client-side raw ZodError, page down unrecoverably | code M1, arch L2 | fix (b) server-side safeParse → 500 `AUDIT_ROW_INVALID` |
| Cursor payload shared across surfaces (messages token verifies on audit endpoint) | security M1 | fix (d) `surface` discriminator + ownership grant for `platform/cursor.ts` + messages call sites |
| INVALID_CURSOR recovery comment wrong (refetch replays pageParams) | code M2, frontend M4 | fix (e) start-over via resetQueries; messages side → D-CAP-044-L |
| Not-authorized panel silent (a11y) | frontend M3 | fix (e) `role="status"` |
| AC 13 nav clause unmet / `/admin` undiscoverable | code H1, arch M2, QA M2, frontend M2 | ruling 1 → D-CAP-044-K |
| Upgrade-path seed gap | security M2, code L6 | ruling 3 → D-CAP-044-N |
| False INVALID_RESPONSE comment; `ip` field comment overstates | arch L1, security L2 | fix (f) |
| Half-set resource pair silently matches nothing | arch L3 | fix (c) guard throw |
| Tie-breaker / exact-limit / cursor-chaining tests unpinned | code L1/L2/L3 | fix (g) |
| security.md enum list stale | arch M1, security L1 | orchestrator closure duty |
| Session header/logout | frontend M2 | AC 22 (Slice 3) by contract |
| Filters not URL-addressable | frontend L5 | D-CAP-044-M |
| Cursor not bound to filter set | code L4 | accepted (house-consistent; promotion note recorded) |
| Empty-cursor divergence audit vs messages | code L5 | accepted (align at next cursor.ts touch) |

## Positive evidence worth keeping

- QA's full AC 8–14 evidence table: every clause PASS, including cursor-walk disjointness,
  exactly-one-request-on-403, and shape parity with `auditEventSchema`; the two hook-racing
  seed tests pass 17/17 in isolation, and the administrator-gains-`audit.read` fact is
  directly asserted by a passing `checkPermission` test — AC 8 does not rest on the racing
  tests.
- Security verified all 14 audit-writer metadata call sites are ids-only (no writer can set
  `ip` — structurally impossible today; `R-SECRET-003` holds: no secret reachable via audit
  queries).
- Code verified by direct read: 12 bind slots ↔ 12 placeholders in order; keyset predicate ↔
  `ORDER BY created_at DESC, id DESC`; error-middleware ZodError→400; ApiClient error
  passthrough; `retry: false` global.
- Architecture confirmed boundary discipline (route imports only `modules/admin/index.ts` +
  contracts; every changed file inside the slice-2 ownership row), enum+seed+tests moved
  together with member non-grant explicitly tested, and every convention claim (mount style,
  requirePermission → zod → one use case → envelope, infinite-query mirror, beforeLoad guard)
  matches its named precedent.
- Frontend confirmed the query-key discipline (filters serialized through the same path
  builder the fetcher uses — identical filter sets share one cache entry).

## Fix pass

Dispatched 2026-08-24 as a single implementer with criteria (a)–(g), slice-2 ownership plus
the (d) ownership grant. Validation record appended to task.md §"Slice 2 fix-pass outcome"
after orchestrator diff review + full gate re-run.
