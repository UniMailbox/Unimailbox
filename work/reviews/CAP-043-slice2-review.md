# CAP-043 Slice 2 — 5-way review round (2026-08-23/24)

Slice under review: message detail + thread (AC 9–12) — uncommitted working tree on `claude/cap-042-better-auth-integration-c47133` after `422b4ab` (Slice 1). All five reviewers ran in parallel against the same dirty tree. Consolidated verdict: **fix pass required** (contracted in `work/active/CAP-043-inbox-message-thread/task.md` §"Slice 2 review outcome → fix pass", criteria G1–G12).

| Reviewer | Verdict | Full report |
|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | `work/reviews/CAP-043-architecture-review-slice2.md` (on disk) |
| code | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| security | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| frontend | ACCEPT-WITH-FOLLOWUPS | final message only; consolidated below |
| QA | ACCEPT | final message only; consolidated below |

Review dispatch note: this round ran under the newly repaired SubagentStop
validator (`4dec8e4`); all five reviewers stopped cleanly — first full round
with a functioning handoff gate.

## Findings rolled into the fix pass

### Security M1 + Architecture L2 — thread query unbounded; recipients IN-clause breaks D1's 100-parameter limit

- `message-read-repository.ts:449-468` (query B, no LIMIT) and `:499-509` (recipients `IN (…)` binding every thread member id).
- A thread with >100 members exceeds D1's bound-parameter ceiling → the whole request fails (500), not a degradation. Architecture had rated the missing cap a design-margin LOW; security's parameter-limit angle makes it a correctness defect.
- **Fix** → G1: `ORDER BY created_at DESC, id DESC LIMIT 50` (named `THREAD_MAX_ITEMS`), reversed to ASC in JS; recipients fetch naturally bounded ≤50 ids; 120-member boundary test.

### Architecture M1 ≡ Code M4 ≡ Security L2 — `getMessageDetail` ignores per-user soft delete

- `message-read-repository.ts:341-357` lacks the `COALESCE(mus.is_deleted, 0) = 0` predicate that the inbox list (Slice 1) and thread anchor/items (Slice 2) apply.
- Architecture's failure scenario: post-Slice-3, a soft-deleted anchor renders a half-broken page — detail body 200 while the thread panel on the same page 404s; the detail endpoint returns a message that is "gone for that user" per D-CAP-043-B.
- Architecture proposed binding the fix to Slice 3's envelope; the orchestrator pulled it into the in-flight fix pass instead (same file, earlier closure, Slice 3 not yet dispatched).
- **Fix** → G2 (+ both-user worker test).

### Code L1 — empty-string `message_id_header` fuses unrelated messages

- `THREAD_ROOT_SQL`'s final tier returns `m.message_id_header` unconditionally; `''` (not NULL) resolves root `''`, and every other header-less empty-string message in the mailbox also resolves `''` → `'' = ''` matches → unrelated messages thread together. The NULL-singleton protection only covers actual NULLs.
- **Fix** → G3: `NULLIF(m.message_id_header, '')` in the ELSE tier + two-singleton test.

### Frontend M1 ≡ Code M1 — every reopen of an already-read message fires a redundant PATCH

- `mailbox-queries.ts` mark-read `onSuccess` flips only the inbox infinite-query cache; the detail cache entry still holds `isRead: 0`, so the exactly-once-per-mount guard re-fires on every reopen.
- **Fix** → G6: flip `mailboxQueryKeys.message(...)` too (additive `setQueryData`) + reopen regression test.

### Frontend M2 ≡ Code L7 — sibling navigation mark-read is designed but unproven

- The route reuses the component instance on param change (`remountDeps` unset); the `markedMessageRef` guard is built for it, but no test exercises A→B→A.
- **Fix** → G7: sibling-navigation test (exactly one PATCH per newly-opened unread id, none repeated).

### Code M2 — malformed-References tier fallthrough untested

- `THREAD_ROOT_SQL`'s first-token extraction on `'no brackets here'`, `'<'`, `'><'` must fall through to the in_reply_to / message-id tiers; no test proves it produces no garbage roots.
- **Fix** → G4.

### QA L1 — in_reply_to-only tier unproven

- The D-CAP-043-C priority order's middle tier (no References, valid In-Reply-To) has no dedicated test.
- **Fix** → G5.

### Code M3 — thread-error branch untested

- `message-thread-error` inline panel (thread fetch fails, page survives) has no test.
- **Fix** → G8.

### Frontend L1 ≡ Code L3 — mark-read failures swallowed silently

- The mutation result is ignored; a failed PATCH neither logs nor surfaces anywhere.
- **Fix** → G9: `onError` `console.warn` (mailboxId, messageId, error) — first web logging site; failure genuinely ignorable (page keeps rendering), so warn, not an error boundary.

### Frontend L2 — from-address double render

- `MessageDetailPage.tsx:146` (Card description `From …`) and `:148` (`message-from` row) render the same formatted string.
- **Fix** → G10: single render + exactly-once assertion.

### Frontend L3 — InboxListPage address lookup untested

- The Slice-2-fe-LOW mailbox-address lookup (`InboxListPage.tsx:80`) landed without a test.
- **Fix** → G11: address-shown / UUID-fallback test.

### Architecture L1 — ratified out-of-envelope file missing from persisted ownership amendment

- `packages/contracts/src/index.test.ts` was ratified in dispatch conversation only. **Fixed by the orchestrator before dispatching the fix pass** — the amendment in task.md now lists it.

## Deferred (recorded in task.md §"Slice 2 … Deferred to Slice 3 / closure")

- Architecture L4 — fourth copy of the ~15-line route authz preamble (sixth site arrives with Slice 3 star/delete) → extract a shared helper during Slice 3's edit of `messages.ts`.
- Architecture L3 — `THREAD_ROOT_SQL` per-row CASE scan, no index can serve it → stays with the D-CAP-043-C `thread_id` backfill follow-up, recorded in the ledger at closure.
- `message-read-repository.ts` length (approaching 250+ lines) → split decision at Slice 3 completion.
- `assertCan` 404-vs-403 deny-shape oracle → closure-time recorded decision.
- Detail page Back link / title raw UUID → cosmetic, rides with Slice 3 web work if touched.

## QA verification highlights

All four Slice 2 ACs (9–12) verified with evidence: detail route 404 shape identical for non-existent vs cross-mailbox (no existence leak), per-user isRead on detail and thread, thread oldest-first ordering + D-CAP-043-C priority order proven for the thread_id and References tiers, exactly-once mark-read on first open (single-mount), web states (loading/error/unauthorized/data) present. QA's L1 is the unproven in_reply_to tier → G5.

## Fix pass outcome

**Complete — all twelve criteria (G1–G12) implemented and validated.** Implementer
`implementer-slice2-fix` (2026-08-24); the orchestrator validated the diff
file-by-file against the criteria and ran the full gates itself.

- G1–G5 (worker): `THREAD_MAX_ITEMS = 50` named constant citing the D1 100-parameter limit; root branch `ORDER BY created_at DESC, id DESC LIMIT ?` reversed in JS to oldest-first; singleton branch untouched; `getMessageDetail` gains the soft-delete predicate (404 for the deleting user, 200 for the other member); `THREAD_ROOT_SQL` final tier `NULLIF(m.message_id_header, '')`; malformed-References fall-through (both next tiers), empty-string singletons, and the in_reply_to-only tier each carry a dedicated worker test. The implementer ran a red/green probe on G1: cap temporarily removed → the 120-member test gets HTTP 500 from D1's parameter limit (the defect made visible); cap restored → 200 + exactly 50 newest items, root excluded, all items with parsed recipients.
- G6–G11 (web): mark-read `onSuccess` additionally flips the detail cache entry (additive copy) — reopen regression test proves one PATCH total across open → back → reopen; sibling-navigation test proves exactly one PATCH per newly-opened unread id under the reused component instance; thread-error branch test (body renders, inline retry panel, refetch on retry); `onError` warn with mailboxId/messageId/code (first web logging site); Card description no longer duplicates the from address (exactly-once assertion); InboxListPage address-lookup tests (cache hit shows address, empty cache falls back to UUID, no crash). No defect found in `InboxListPage.tsx`.
- G12 (gates, orchestrator-run): doctor 13/13 · typecheck clean · lint clean · unit **672/672** (665 baseline + 7 new web tests) · worker **676/680** — the 4 failures are exactly the documented pre-existing D1-parallelism set (`migrationsDb` R-DATA-004, `admin` permissions ×2, `0015_credential_backfill`), +6 new tests all passing · build EXIT=0 with wrangler `--dry-run` clean.

Verdict after fix pass: **Slice 2 accepted.** Deferred items remain recorded in
task.md §"Slice 2 … Deferred to Slice 3 / closure" (route-authz helper extraction
at the sixth site, `THREAD_ROOT_SQL` CASE scan with the `thread_id` backfill,
repository split decision, `assertCan` oracle, cosmetic UUID displays).
