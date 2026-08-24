# CAP-044 Slice 1 — 5-way review round (2026-08-24)

Slice under review: compose + reply web vertical (ACs 1–7) — uncommitted working tree on
`claude/cap-042-better-auth-integration-c47133` at `c170ef0`. All five reviewers ran in
parallel against the same dirty tree; none wrote the code. Consolidated verdict:
**fix pass required** — criteria (a)–(i) contracted in
`work/active/CAP-044-compose-reply-admin/task.md` §"Slice 1 review outcome → fix pass".

| Reviewer | Verdict | BLOCKER | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 3 | 3 |
| code | **REJECT** | 0 | 1 | 1 | 6 |
| security | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 3 | 4 |
| frontend | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 4 |
| QA | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 2 | 5 |

All reports are final-message-only; consolidated below. QA re-ran the unit suite independently
(741/741, 50 files); frontend re-ran the five touched web test files (57/57); both matched the
orchestrator's counts exactly.

## The two HIGHs (both mandatory in the fix pass)

### Code H1 — `buildReplyContext` diverges from `THREAD_ROOT_SQL` for malformed References (AC 6 break)

`reply-context.ts:60` selects the references base with JS truthiness
(`referencesHeader || inReplyToHeader || ''`), but the SQL tier-1 authority accepts
`references_header` only when it contains a token pair (`instr('<') > 0 AND instr('>') > instr('<')`).
Failure scenario: parent with `referencesHeader: 'no brackets here'`, `inReplyToHeader:
'<root@example.com>'` — the parent's thread works (SQL falls to tier 2, root `<root@example.com>`),
but the client builds `references = 'no brackets here <p@x>'`, so the reply's tier-2 root is
`<p@x>` ≠ the parent's root: **the sent reply never joins the thread it was replied from**, and
the malformed value propagates to the next generation. The malformed class is realistic — it is
exactly what CAP-043's G4 fix (`messages.worker.test.ts:1577-1618`) treats as a stored class.
→ criterion (a). Related: QA L5 (mirror subtlety — SQL compares first-`>`-overall vs
first-`<`-overall, so `x> <a@b.c>` falls through; add the comment).

### Frontend H1 — failed background refetch destroys the typed reply draft and can tear down the send confirmation

`ComposeEmail.tsx:162-185` branches loading → `error` → `data`. `messageDetailQuery` has
`staleTime: 0`, so opening a reply from a cached detail (the normal detail → Reply path)
immediately fires a background refetch; with the global `retry: false`, a transient failure sets
`error` while `data` is still defined → the mounted form is unmounted and the **typed draft is
destroyed**. After a successful send, the mutation's invalidation refetches the parent; if that
read fails, the **success confirmation — the only receipt of the mutating action — is torn down**
and replaced by "The reply cannot be pre-filled". Same branch shape exists in CAP-043's
`MessageDetailPage` but only swaps a read-only view; the composer is the first place it holds
user input. → criterion (c), data-first branch ordering. Frontend M2 is subsumed by this fix.

## The tri-flagged MEDIUM

### Frontend M1 ≡ Architecture M1 ≡ Code M1 — stale `replyContext` on a second send from the still-open reply page

Success resets the form to blank but the `replyContext` prop persists: a second, unrelated
message typed into the now-blank form silently carries the old `inReplyTo`/`references` — it
joins the old thread in Unimailbox AND in the recipient's mail client (headers flow into the
outbound email, `process-outbound-job.ts:251`), irreversibly once delivered. Three independent
reviewers flagged it. → criterion (d): clear the context on success.

## Other findings → fix-pass criteria

- **Code L1** — `messageIdHeader: ''` (a real stored value per the worker's own G3/NULLIF
  comment) is not treated as case d; yields empty threading headers. → criterion (b).
- **Code L5** — double-submit race (click→re-render + async resolver window admit two submits →
  two fresh keys → duplicate send). → criterion (e), `isPending` bail in `onSubmit`.
- **Code L2** — malformed 202 body surfaces a raw ZodError as `UNKNOWN` with an ugly JSON
  message; `client.ts` already defines `INVALID_RESPONSE`. → criterion (f1).
- **Security L1** — unencoded path interpolation in `mailbox-queries.ts` fetch paths; the new
  `?replyTo=` param makes the detail path attacker-influenced (GET-only, negligible impact —
  response fails schema parse; hygiene fix). → criterion (f2).
- **Frontend L1** — whitespace-only `?replyTo=` passes `!== ''` → guaranteed parent 404 instead
  of the blank composer. → criterion (g), trim before the check.
- **Frontend L2** — `autoComplete="email"` on To/Cc offers the *user's own* address for a
  recipient field. → criterion (h), remove the prop.
- **Security M3 ≡ QA L2** — no 403-surfacing test (R-MESSAGE-011's named case); only 409 is
  exercised, though the path is code-agnostic. → criterion (h1).
- **QA M2 ≡ Code L3** — body bound (≤1,000,000) and empty-body-send have zero test evidence.
  → criterion (h2)/(h3). Code L3 also notes the whitespace-only-subject test gap → (h4).
- **QA L1** — trailing-comma To parsing (`a@b.c,,`) untested → (h5). QA L3 — reply-send failure
  keeps threading headers, structurally guaranteed but untested → (h6).
- **Code L4** — `buildReplyContext`/`ReplyContext` barrel exports have no barrel consumer →
  criterion (i), remove after grep-verifying.

## Rulings (open questions from the contract)

- **`compose.ts:145` provider resolution vs R-OUTBOUND-001 — RULED: carry as a deferred row**
  (security M1). Zero worker files changed (pre-existing CAP-023 behavior, fenced out of scope);
  single-tenant per deployment; with exactly one active connection the resolution is
  behaviorally identical to R-OUTBOUND-001's tail tier; the failure mode with ≥2 connections is
  mis-dispatch within one deployment, not authz bypass, secret exposure, or data loss.
  Conditions: deferred row keyed to the missing domain-override tier at closure; CAP-045 asserts
  the single-active-connection topology; any future multi-connection capability implements
  domain-override selection before a second active connection can exist.
- **Threading e2e proof (QA M1) — RULED: recorded follow-up, does not block Slice 1.** The
  e2e claim decomposes: (a) server grouping by references/in-reply-to — worker-proven in
  CAP-043; (b) send route persists `inReplyTo`/`references` — implemented (verified by two
  reviewers reading the INSERT) but **zero** of the 16 compose worker tests send threading
  headers; (c) web-computed references match the parent root — proven against the local mirror
  only. Follow-up = one worker test seeding a parent via the real send route, POSTing a reply
  with client-shaped headers, asserting thread-endpoint grouping; home `compose.worker.test.ts`
  (leg b) and/or `messages.worker.test.ts`. Also the concrete drift guard for the day
  `thread_id` (SQL tier 1, written by nobody today) gets backfilled — deferred as D-CAP-044-J.
- **Security M2 — unbounded `inReplyTo`/`references`** (no per-field max in
  `composeRequestSchema`; a hostile ~1 MB inbound References header — the inbound path is exempt
  from the 1 MB body cap — makes its reply permanently 413-blocked from the UI; direct API
  callers can store ~1 MB of threading text per send). **Deferred as D-CAP-044-I**: the fix
  needs a deliberate cap-value + truncation-strategy decision (truncation must preserve the
  root-first token); reviewers themselves judged it ledger-recordable. No silent truncation
  exists anywhere today (good).

## Accepted as-is / routed elsewhere

- **Architecture M2** — client-mirror ↔ `THREAD_ROOT_SQL` drift surface has no automated
  cross-check. The client-side layering itself is correct (D-CAP-044-C stands; Rule of Three
  keeps `buildReplyContext` out of contracts with one consumer). Closure documentation duty:
  implementation log records the coupling + the promotion trigger (second consumer → promote
  the helper into contracts). Ties to D-CAP-043-K (`thread_id` backfill).
- **Architecture M3** — thread-panel Reply deferral was conversation-only; now recorded in
  task.md §Out of scope (2026-08-24).
- **Architecture L1 ≡ Security L2** — char-count vs byte-cap mismatch on the body field
  (ApiClient measures UTF-16 units; a ~350k-char CJK body passes client validation, hits the
  real byte check, 413 surfaces inline). Pre-existing `client.ts` (owned by no slice);
  UX polish, enforcement intact.
- **Architecture L2** — four new CSS classes (`inbox-compose-entry`, `message-detail-actions`,
  `compose-confirmation`, `compose-body`) await Slice 3 `tokens.css`; AC 22 checklist must
  include the two page-action classes as well as the composer.
- **Architecture L3** — `Re:` for an empty parent subject: accepted (honest `Re:` beats a
  fabricated subject).
- **Frontend L3/L4** — skeleton shape divergence, reply-mode back-link target: Slice 3
  styling-pass judgment.
- **QA L4 ≡ Code L6** — compose-route `beforeLoad`/`useSearch` wiring proven by construction +
  `validateComposeSearch` unit tests; consistent with the repo's mirror-test convention.

## Positive evidence recorded (audit value)

- Server re-validation intact (`compose.ts:126` parses with `composeRequestSchema`; body-size
  middleware global on `/api/v1/*`); client caps are strict subsets of server caps.
- Authorization runs **before** the idempotency replay lookup (`compose.ts:91` precedes
  `:112`) — a foreign-mailbox replay can never leak a stored response; foreign-mailbox compose
  and reply surface 403/404 through user-visible panels, never silently.
- `fromAddress` non-nullable in `messageDetailSchema` (the `.trim()` is safe); `values.subject`
  carries the zod-trimmed output (proven by the typed `'  Hello there  '` payload test);
  whitespace-only subject rejected by trim-then-min(1).
- The retry test genuinely inspects captured `idempotency-key` headers and asserts distinct
  UUIDs; the ApiClient mints a fresh key per fetch call; `mutations.retry: false` at
  `App.tsx:64-66`.
- No secret material, no new `console.*`, no `localStorage`/sessionStorage (the storage-guard
  glob sweeps the new files), no `dangerouslySetInnerHTML` anywhere in `apps/web`; the
  confirmation's messageId is schema-constrained to a UUID before rendering.
- Zero `apps/worker/**` files changed (verified by three reviewers independently); the 16
  pre-existing compose worker tests untouched.
- React 19 + `Input`'s `...rest` spread lands RHF's ref on the native input;
  `focusFieldBy` walks registration order = DOM order, so `shouldFocusError` genuinely focuses
  the first erroring field (two tests assert focus).
