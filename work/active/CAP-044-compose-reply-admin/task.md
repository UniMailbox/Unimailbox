# CAP-044 — Compose/reply and admin users/webhook/audit surfaces

> The shared contract for this capability. Every agent working on it reads this file first.

**Phase:** 2 · **Status:** In Progress · **Started:** 2026-08-24

## Goal

A signed-in user can compose and send a message (or reply to one, correctly threaded) from the web
client, and an administrator can inspect users, provider-connection/webhook metadata, and the audit
trail from the web client — without any secret being exposed.

## Scope

- **Slice 1 — Compose + reply (web vertical):** compose form (To, Cc, subject, plain-text body),
  `POST /api/v1/mailboxes/:mailboxId/messages/send` mutation, reply pre-fill from a message's
  detail data, `composeResponseSchema` promoted into `packages/contracts`.
- **Slice 2 — Audit-event query (CAP-033 absorbed):** `audit.read` permission key, audit-event
  query repository (by actor and by resource, composable, cursor-paginated),
  `GET /api/v1/admin/audit-events`, web admin shell + audit-events page.
- **Slice 3 — Admin users + webhook metadata + styling:** `GET /api/v1/admin/users` (identity-owned
  read), contracts, web users page; web connections + webhook-events pages over the already-live
  endpoints (reveal button included); the D-CAP-043-L styling pass for inbox/compose/admin
  surfaces.

## Out of scope

- **Draft persistence** (`drafts` table, `PUT` + `If-Match` concurrency, R-MESSAGE-008..010) —
  Phase 3 capability. The composer is send-only (D-CAP-044-A).
- **Rich-text editing (Tiptap) / HTML compose** — Tiptap is not installed; the composer writes
  `textBody` only and sends `htmlBody: ''` (D-CAP-044-B). Tiptap lands with the Phase 3
  signatures/rich-compose capability.
- **BCC in the composer UI** — recipient passthrough privacy for BCC needs provider-side design;
  deferred with the drafts capability. `composeRequestSchema` still has no `bcc` field; do not add
  one here.
- **Forward** — reply only. Forward needs quoting/attachment semantics that do not exist yet.
- **Reply from the thread panel** — a per-row Reply link requires restructuring each thread row
  from a full-width `<button>` (interactive-inside-interactive); deferred with the UX pass.
  Reply remains on every message's detail page, one click from the thread panel. (Recorded from
  the Slice 1 architecture review — was a conversation-only decision.)
- **User management mutations** (ban, role assignment UI, invite-code UI) — only the users *list*
  ships here. `user.manage` endpoints already exist (invite-codes).
- **Provider-selection rework** — the send route's provider resolution stays as-is this
  capability; see Open questions.
- **Converting legacy phase-1 lists** (webhook-events, blocklist, invite-codes) to cursor
  pagination — follow-up row at closure (D-CAP-044 basis); only NEW endpoints here use cursors.
- **`message-read-repository.ts` split (D-CAP-043-M)** — CAP-044 does not modify the messages
  module's persistence; the split re-defers to the Phase 3 drafts capability, its next real
  consumer.

## Business rules

| Rule ID | What it means for this capability |
|---|---|
| `R-MESSAGE-011` | Send requires `message.send` permission + `assertCan(userId, mailboxId, 'send')` — already enforced by the existing route; the web mutation must surface 403 as a user-visible error, never silently drop. |
| `R-OUTBOUND-005` | The send request carries `Idempotency-Key` (the ApiClient already mints per-call and reuses across 5xx/429 retries). One user action = one mutation call = one key. |
| `R-OUTBOUND-006` | Send + job + idempotency record in one D1 batch — already implemented (CAP-023/027); this capability must not regress it. |
| `R-OUTBOUND-010` | To and Cc are real recipient types passed through — the composer sends both; no BCC (Out of scope). |
| `R-AUDIT-001` | No NEW state transitions are introduced by this capability (users/audit lists are reads; reveal already audited). Reviewers must confirm this, not assume it. |
| `R-AUDIT-003/004` | Audit query returns actor, action, resource, request ID, IP, metadata as stored — immutable rows; the query surface never offers mutation. |
| `R-SECRET-003` | No secret values in ANY new response or page. The connections page shows `webhookConfigured`/`webhookUrl` only; the reveal button uses the existing audited endpoint and its one-time-display semantics (exception defined 2026-08-24 in the rule). |
| `R-AUTHZ-002/003/005` | Every new admin route has `requirePermission` against the closed enum; admin identity is role-based; no implicit bypass. |
| `R-API-004/005` | Cursor pagination on both new list endpoints: HMAC-signed `(created_at, id)` via `platform/cursor.ts`; `{ data: { items, nextCursor } }`. |
| `R-DATA-001` | Email addresses handled case-insensitively — validation `.trim().toLowerCase()` before compare/submit. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. Each maps to a test or a demonstrable behaviour. Numbering is stable;
review rounds reference these IDs.

### Slice 1 — compose + reply

- [x] 1. A Compose entry point exists in the mailbox UI and opens the composer for the active
  mailbox.
- [x] 2. The composer form (React Hook Form + zod) validates: To ≥ 1 valid email, Cc 0+ valid
  emails, subject required non-empty ≤ 998 chars, body ≤ 1,000,000 chars (may be empty); every
  field has a programmatic label; validation errors are announced (aria-describedby or
  equivalent) and submitted-but-invalid focuses the first error.
- [x] 3. `composeResponseSchema` (`{ data: { messageId: uuid, status: 'queued' } }`) is exported
  from `packages/contracts` with schema tests; the web mutation parses the 202 response with it.
- [x] 4. Sending: submit disabled while pending; on 202 the form resets, a success confirmation
  shows the returned `messageId`, and mailbox list queries are invalidated (next render refetches);
  on error the form STAYS filled, the stable error `code` and message are shown inline, and the
  user can retry (a retry is a new mutation call → new Idempotency-Key, never a silent auto-replay).
- [x] 5. Reply: `MessageDetailPage` offers Reply; it opens the composer pre-filled per
  D-CAP-044-C: `to` = the parent's `fromAddress`; `subject` = `Re: <parent.subject>` (no double
  prefix when already `Re:`/`RE:`); `inReplyTo` = parent `messageIdHeader`; `references` =
  space-join of the threading base and parent `messageIdHeader`, trimmed. (Fix pass (a) refined
  the base selection from the `??`/truthiness formulation to the exact `THREAD_ROOT_SQL` tier
  conditions — references base only with a `<…>` pair, in-reply-to base when non-null and
  non-empty, mirroring the SQL tier-for-tier.)
- [x] 6. Threading invariant (dedicated unit test): across the four parent shapes — (a) has
  references, (b) references empty + has in-reply-to, (c) neither (root), (d) `messageIdHeader`
  null — the constructed reply's `references` FIRST token equals the parent's resolved root under
  CAP-043 `THREAD_ROOT_SQL` tier 1, or the reply carries no threading headers at all (case d).
- [x] 7. The reply composer sends with `inReplyTo`/`references` in the body and they reach the API
  request payload (web test asserts the POSTed JSON); no worker-side change to the send route is
  made (the 16 existing compose worker tests must remain green, unmodified in behavior).

### Slice 2 — audit-event query (CAP-033)

- [x] 8. `audit.read` is added to the closed `PermissionKey` enum in `packages/contracts`
  (D-CAP-044-D) with enum-closure tests updated; the seeded `administrator` role gains it; the
  `member` role does not.
- [x] 9. An audit-event query repository in `modules/admin` filters composable:
  `actorUserId?`, `resourceType?` + `resourceId?` (pair), `action?`, each optional; ordered
  `created_at DESC, id DESC`; cursor-paginated via `platform/cursor.ts`; served by the existing
  `audit_events_actor_idx` / `audit_events_resource_idx`. (Fix pass (a), after the review's
  EXPLAIN QUERY PLAN finding: the single-statement `? IS NULL OR …` shape never selected the
  indexes — the query now composes bare predicates per active filter, null-bound slots for the
  cursor boundary only, so the actor/resource indexes are selectable; verified by the
  cross-reviewer evidence and behavior-identical tests.)
- [x] 10. `GET /api/v1/admin/audit-events` — `requirePermission('audit.read')` + authn; query
  params validated with a zod schema from contracts; response `{ data: { items: AuditEvent[],
  nextCursor } }`; `metadata` returned as the stored JSON string (opaque, `string | null`).
  (Fix pass (b) added the server-side enum detection point: an out-of-enum `action` row is a
  500 `AUDIT_ROW_INVALID`, never a 200 the client cannot parse.)
- [x] 11. Worker tests: anonymous 401; member (no `audit.read`) 403; administrator 200; filter by
  actor; filter by resource pair; combined actor+resource; cursor walk across a page edge returns
  disjoint pages and a null cursor at the end; empty result → `{ items: [], nextCursor: null }`;
  every returned row's shape matches `auditEventSchema` (contracts test parity). (Fix pass (g)
  added: created_at tie-breaker across a page edge; exact-limit tail; cross-surface cursor
  rejection both directions; corrupt-row 500; half-pair repository throws.)
- [x] 12. `auditEventSchema` + `auditEventListResponseSchema` + the query-params schema live in
  `packages/contracts` (admin/audit.ts or index.ts per existing layout) with tests.
- [x] 13. Web: an `/admin` section (session-guarded; nav entry visible only when the session can
  read admin surfaces — hide, do not 403-crash, for members) with an AuditEventsPage: actor and
  resource filters, action filter, cursor pagination ("load more"), and explicit
  loading/error/empty states. (Nav-entry clause AMENDED by the Slice 2 review ruling — the
  session descriptor carries no role signal, so "visible only when the session can read" is
  unmeetable client-side; the member-side half (one request → not-authorized panel, no crash
  loop, `role="status"`) is met and test-proven. The nav entry + probe gating are D-CAP-044-K
  into Slice 3. Fix pass (e) hardened the error states: data-first, filter form always mounted,
  INVALID_CURSOR start-over.)
- [x] 14. Web tests: audit query hook builds the right query string per filter combination;
  member-without-permission renders the not-authorized state (no API crash loop); pagination
  accumulates rows. (Fix pass (g): the accumulation test now asserts the second fetch URL
  carries the cursor parameter.)

### Slice 3 — admin users + webhook metadata + styling

- [x] 15. The identity module exports a public `listUsers` read (cursor-paginated, ordered
  `created_at DESC, id DESC`) — the ONLY new code inside `modules/identity`; the `users` table
  stays identity-owned.
- [x] 16. `GET /api/v1/admin/users` — `requirePermission('user.read')`; response rows carry id,
  email, display name, created_at (as stored), and account status IF a status column exists — and
  NEVER password-hash or credential columns; a worker test asserts the response JSON contains no
  key matching /hash|credential|secret|token/i. *(Status exists — 0001 CHECK; regex extended to
  /password\|salt\|hash\|credential\|secret\|token/i by fix (h).)*
- [x] 17. Worker tests for users list: anonymous 401; member 403; administrator 200; cursor walk;
  empty deployment edge (only the admin themselves); shape matches the contracts schema. *(QA
  evidence additionally pinned: exact-limit tail, created_at tie-breaker, tamper, cross-surface
  ×2, limit validation + clamp.)*
- [x] 18. `userListItemSchema` + list response schema in `packages/contracts` with tests.
- [x] 19. Web UsersPage: table with the list fields, cursor pagination, loading/error/empty
  states; linked from the admin section nav. *(Rendered as the house `ul/li` row list — QA L3,
  accepted.)*
- [x] 20. Web ConnectionsPage over `GET /api/v1/admin/connections` (`webhook_event.read`):
  connection rows with provider, status, `webhookConfigured`, `webhookUrl`; a reveal action calls
  the existing `POST .../webhook-secret/reveal` behind a confirm dialog, displays the value once
  with an explicit "this is shown once / the reveal is audited" note, and never logs or persists
  it (asserted in a web test via the logging spy pattern used in CAP-043). *(Fix (f): mutation
  gcTime 0, stale error cleared on retry.)*
- [x] 21. Web WebhookEventsPage over `GET /api/v1/admin/webhook-events`: rows with delivery
  metadata as the API returns them; loading/error/empty states.
- [x] 22. Styling pass (closes D-CAP-043-L): `tokens.css` gains the real class definitions for
  the inbox surfaces (`.inbox-*`), the composer, and the admin pages; every state variant
  (default/loading/error/empty) remains distinguishable after styling; no inline style props
  where a token class exists. *(Reviewer-verified zero unresolved classes / zero inline styles;
  divider defect fixed by fix (e). Closes D-CAP-043-L.)*
- [x] 23. Gates (orchestrator-run after each fix pass): `pnpm scaffold doctor` 13/13;
  `pnpm typecheck` clean; `pnpm lint` clean; `pnpm test:unit` all green (count grows by the new
  tests); `pnpm test:worker` green except exactly the 4 documented
  `D-CAP-042-pre-existing-parallelism` failures; `pnpm build` EXIT=0. *(Post-fix-pass
  orchestrator run: doctor 13/13 · typecheck 0 · lint 0 · unit **863/863** (850 + 13 fix-pass
  tests) · worker **732/736**, the 4 failures verified by name · build 0.)*

## Vertical slice

- [ ] contract schema — `packages/contracts/src/index.ts`, `packages/contracts/src/admin/audit.ts`
- [ ] repository — `apps/worker/src/modules/admin/audit-query-repository.ts` (new),
  `apps/worker/src/modules/identity/*` (`listUsers`), `apps/worker/src/modules/admin/seed-repository.ts`
  (audit.read seed)
- [ ] route — `apps/worker/src/http/routes/admin-audit-events.ts` (new),
  `apps/worker/src/http/routes/admin-users.ts` (new), `apps/worker/src/http/router.ts` (mounts)
- [ ] client — `apps/web/src/features/mailbox/ComposeEmail.tsx` (+ compose mutation in
  `mailbox-queries.ts`), `apps/web/src/features/admin/**` (new), `apps/web/src/app/router.tsx`,
  `apps/web/src/styles/tokens.css` (styling pass)
- [ ] tests — `apps/worker/src/http/routes/admin-audit-events.worker.test.ts`,
  `admin-users.worker.test.ts` (new), `apps/worker/src/modules/admin/*.test.ts` as needed,
  web tests colocated, `packages/contracts/src/index.test.ts`

New module dependency edges introduced: **none** (`admin → identity` is already allowed;
`messages` untouched).

## Delivery path

- Compose: browser `/mailbox/$mailboxId` → ComposeEmail form → ApiClient POST
  `/api/v1/mailboxes/:id/messages/send` (`Idempotency-Key`) → existing route (validate →
  assertCan 'send' → one D1 batch: message + recipients + mailbox_messages + outbound_jobs +
  idempotency record) → `OUTBOUND.send({jobId})` → queue consumer → Brevo adapter → webhook →
  status. CAP-044 adds only the client side + response contract.
- Audit query: browser `/admin/audit-events` → ApiClient GET with filters → route →
  `requirePermission('audit.read')` → query repository (indexed) → cursor envelope → page.
- Users: browser `/admin/users` → GET → `requirePermission('user.read')` → identity
  `listUsers` → cursor envelope → page.
- Build/runtime configuration touched: none (no new bindings, migrations, or wrangler changes —
  `audit.read` is seed data + enum, not a migration).
- Fresh-deploy evidence required: no (CAP-045 owns preview verification); worker-pool tests
  against real D1 are the evidence standard here.

## Reference implementation

Per `.claude/rules/reference-implementations.md`; the canonical decisions live in
`docs/rebuild/11-agentic-inbox-adaptation.md`.

| Field | Value |
|---|---|
| Repository + pinned commit | Agentic Inbox — pinned in `docs/rebuild/11-agentic-inbox-adaptation.md` (see its Provenance section; do NOT fetch "latest") |
| License | as recorded in the adaptation doc |
| Files inspected | `app/components/ComposeEmail.tsx`, `app/hooks/useComposeForm.ts`, `app/components/RichTextEditor.tsx` (per the doc's planned-use table, CAP-044 row) |
| Adopt | compose form interaction patterns; typed query/mutation organization; explicit loading/empty/error states; reply prefill UX |
| Adapt | send lifecycle = durable outbox + 202 + Idempotency-Key per call (upstream "persist sent before delivery" is REJECTED); pagination = cursor metadata, never page numbers; all types derived from `packages/contracts` |
| Reject | upstream editor implementation (Tiptap absent — D-CAP-044-B); upstream draft persistence; any store-as-event-bus patterns |
| Attribution needed | no (patterns only; no code copied) |

## File ownership

One writer per file. Slices are sequential; within a slice the listed agent is the only writer.

| Agent | Slice | Owns |
|---|---|---|
| implementer-slice-1 | 1 | `packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts`, `apps/web/src/features/mailbox/**`, `apps/web/src/app/router.tsx`, colocated web tests |
| implementer-slice-2 | 2 | `packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts`, `packages/contracts/src/admin/audit.ts`, `apps/worker/src/modules/admin/**`, `apps/worker/src/http/routes/admin-audit-events.ts` (+ its worker test), `apps/worker/src/http/router.ts`, `apps/web/src/features/admin/**`, `apps/web/src/app/router.tsx`, colocated web tests |
| implementer-slice-3 | 3 | `apps/worker/src/modules/identity/**` (+ tests), `apps/worker/src/http/routes/admin-users.ts` (+ its worker test), `apps/worker/src/http/router.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts`, `apps/web/src/features/admin/**`, `apps/web/src/app/router.tsx`, `apps/web/src/styles/tokens.css`, `apps/web/src/features/mailbox/*.tsx` (styling-only edits), colocated web tests |
| reviewer agents | — | `work/reviews/CAP-044-slice{N}-review.md` (one file per round, all five verdicts) |
| orchestrator | — | this file, ledger, implementation log, commits |

`apps/web/src/infrastructure/api/client.ts` is owned by NO slice — it already mints keys/headers
correctly; if a slice believes it must change, stop and report instead.

## Reading list

Give each subagent exactly this:

- `CLAUDE.md` · this file · `.claude/rules/agent-collaboration.md`
- Slice 1: `.claude/rules/coding.md`, `.claude/rules/testing.md`,
  `docs/rebuild/11-agentic-inbox-adaptation.md`, `apps/worker/src/http/routes/compose.ts`,
  `packages/contracts/src/index.ts` (compose + message-detail sections),
  `apps/web/src/features/mailbox/mailbox-queries.ts`, `apps/web/src/infrastructure/api/client.ts`
- Slice 2: `.claude/rules/architecture.md`, `.claude/rules/security.md`, `.claude/rules/testing.md`,
  `apps/worker/src/modules/admin/audit-event-repository.ts`, `apps/worker/src/platform/cursor.ts`,
  `apps/worker/src/http/routes/admin-webhooks.ts`, `apps/worker/src/http/routes/messages.ts`
  (cursor usage), `migrations/0001_initial.sql` (audit_events + indexes)
- Slice 3: `.claude/rules/architecture.md`, `.claude/rules/security.md`, `.claude/rules/testing.md`,
  `apps/worker/src/modules/identity/index.ts`, `apps/worker/src/http/routes/admin-webhooks.ts`,
  `apps/web/src/styles/tokens.css`, `apps/web/src/features/mailbox/InboxListPage.tsx`,
  `apps/web/src/features/mailbox/MessageDetailPage.tsx`

## Dependencies

- Requires: CAP-040 (webhook boundary + audit seam) — Implemented; CAP-043 (inbox/detail/thread)
  — Implemented.
- Absorbs: CAP-033 (audit events queryable by actor and by resource) — D-CAP-044-E.
- Blocks: CAP-045 (preview delivery verification — needs the compose loop to verify).

## Decisions made during this capability

- **D-CAP-044-A — No draft persistence.** Phase 2 scope (`docs/rebuild/08-roadmap/phase-2-core-loop.md`
  "Out of scope: still no drafts"). The composer is send-only; the `drafts` table, `PUT`/`If-Match`
  semantics (R-MESSAGE-008..010), and the messages-repository split (D-CAP-043-M) move to the
  Phase 3 drafts capability together.
- **D-CAP-044-B — Plain-text composer.** `textBody` only, `htmlBody: ''`. Tiptap is uninstalled;
  adding it is a runtime-dependency cost (coding.md) that Phase 2 does not justify. Tiptap lands
  with Phase 3 signatures/rich compose.
- **D-CAP-044-C — Reply context rules (client-computed).** Prefill as in AC 5; the invariant in
  AC 6 guarantees the reply's `references` first token equals the parent's resolved
  `THREAD_ROOT_SQL` root, so replies join the parent's thread. If the parent has no
  `messageIdHeader`, no threading headers are sent.
- **D-CAP-044-D — `audit.read` added to the closed PermissionKey enum.** Deliberate extension:
  audit reading is a distinct authority from `user.read` (personnel data) and `webhook_event.read`
  (delivery ops). Administrator seed gains it; member does not. Enum, seed, and tests change
  together in Slice 2.
- **D-CAP-044-E — CAP-033 absorbed here.** The audit-query API + UI are this capability's
  Slice 2; the CAP-033 ledger row flips at closure with a pointer.
- **D-CAP-044-F — CAP-034 closed via CAP-043.** The HMAC `(created_at, id)` cursor mechanism
  shipped in CAP-043 (`platform/cursor.ts`, inbox-applied, worker-tested). CAP-044's new
  endpoints adopt it. Converting the legacy phase-1 lists is a follow-up row, not scope.
- **D-CAP-044-G — D-CAP-040-B resolved.** `R-SECRET-003` amended 2026-08-24 with the narrow
  webhook-secret reveal exception + controls; the existing audited reveal endpoint stays. No
  list endpoint may return a secret value.
- **D-CAP-044-H — Users read path.** `users` stays identity-owned; identity exports `listUsers`
  (public interface); the admin route consumes it (allowed edge `admin → identity`). No
  cross-module table access.

## Open questions

- `compose.ts:145` still resolves the FIRST active provider connection (comment claims "CAP-024
  will tighten this"). R-OUTBOUND-001 specifies domain-override → first registered → fail. For the
  single-Brevo preview this is behaviorally identical, but the SECURITY and QA reviewers of Slices
  1–2 must explicitly rule on whether the gap is acceptable to carry (and it becomes a deferred
  row) or blocks. Do not fix it inside this capability without an orchestrator decision.
- Whether `users` rows carry an account-status column post-CAP-042 (Better Auth) — the Slice 3
  implementer inspects the actual `users` schema and reports; AC 16's status field is conditional
  on it existing.

## Slice 1 review outcome → fix pass (2026-08-24)

Five-way parallel review (architecture, code, security, frontend, QA; none wrote the code;
unit suite independently re-run 741/741 by two reviewers):

| Reviewer | Verdict | BLOCKER | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 3 | 3 |
| code | **REJECT** | 0 | 1 | 1 | 6 |
| security | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 3 | 4 |
| frontend | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 4 |
| QA | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 2 | 5 |

Orchestrator ruling: **fix pass mandatory** — one HIGH (code) is a genuine AC 6 invariant break,
and one HIGH (frontend) can destroy user input. The stale-`replyContext` second-send hazard was
flagged independently by three reviewers (frontend M1, architecture M1, code M1) and is included.

### Fix criteria (single implementer, slice-1 file ownership unchanged)

- **(a) AC 6 fidelity — malformed References class** (code H1): `reply-context.ts` selects the
  references base with `||` truthiness; `THREAD_ROOT_SQL` accepts `references_header` only when
  it contains a token pair (`instr('<') > 0 AND instr('>') > instr('<')`). Mirror the SQL tier:
  use `referencesHeader` as base ONLY when it contains a `<…>` pair (JS: first `<` at i, then a
  `>` at index > i); otherwise fall through to `inReplyToHeader`. Tests: the malformed class —
  `'no brackets here'` + resolvable `inReplyToHeader`, whitespace-only references, `'<'` alone,
  `'><'` — each asserting the reply's first references token equals the parent's resolved root
  (the existing `resolvedThreadRoot` mirror computes the expectation). These must fail against
  the pre-fix implementation. Also add the one-line mirror comment on the malformed-input
  subtlety (first-`>`-after-first-`<` vs first-`>`-overall) per QA L5.
- **(b)** `reply-context.ts`: treat `messageIdHeader === ''` exactly like `null` (case d — no
  threading headers). Test included.
- **(c) Draft preservation** (frontend H1): `ReplyComposer` branches on `error` before cached
  `data`; `staleTime: 0` means a failed background refetch swaps the mounted form (typed draft
  destroyed) and can tear down the send confirmation after success (invalidation refetch).
  Fix: data-first ordering — render the prefilled form whenever `parentQuery.data` is defined;
  the parent-error panel renders only when there is NO data. Tests: cached data + background
  refetch failure → form stays mounted with user input; successful send + failing parent
  refetch → confirmation persists.
- **(d) Stale threading context** (3× flag): after a successful send in reply mode, the follow-up
  form must NOT carry the old `inReplyTo`/`references`. Lift `replyContext` into `ComposeForm`
  state; on success clear it (title/card degrade to Compose wording) alongside the form reset.
  Test: send reply → success → type a different recipient/subject → send → second POST body has
  NO `inReplyTo`/`references` keys.
- **(e) Double-submit guard**: bail out of `onSubmit` while `composeMutation.isPending` (the
  click→re-render race and RHF's async resolver window can admit two submits → two fresh keys →
  duplicate send).
- **(f) `mailbox-queries.ts`**: (1) wrap `composeResponseSchema.parse` in try/catch and throw
  `ApiError('INVALID_RESPONSE', <readable message>, 0)` instead of surfacing a raw ZodError
  (reuse the client's existing code constant); (2) `encodeURIComponent` the interpolated id/path
  segments in this file's fetch paths (list, detail, thread — the `?replyTo=` value now flows
  into the detail path).
- **(g)** `router.tsx` `validateComposeSearch`: trim `replyTo` before the emptiness check —
  whitespace-only opens the blank composer instead of a guaranteed parent 404. Update its test.
- **(h) `ComposeEmail.tsx` tests + autofill**: remove `autoComplete="email"` from To/Cc (wrong
  semantics — it offers the *user's own* address for recipient fields). Add the missing tests:
  403 surfacing (mock 403 `MAILBOX_ACCESS_DENIED` → code rendered inline, values kept —
  R-MESSAGE-011), empty-body successful send, body 1,000,001 rejection, whitespace-only subject
  rejection, trailing-comma To parsing (`a@b.c,,`), reply-send failure keeps threading headers.
- **(i)** `mailbox/index.ts`: remove the unused `buildReplyContext`/`ReplyContext` barrel
  exports (no barrel consumer; deep imports only — verify by grep first).

### Rulings recorded

- **`compose.ts:145` provider resolution (Open question 1) — RULED: carry as deferred row**
  (security M1). Zero worker files changed; single-tenant per deployment; with exactly one
  active connection the behavior is identical to R-OUTBOUND-001's tail tier; failure mode is
  mis-dispatch within one deployment, not authz bypass. Conditions: deferred row keyed to
  R-OUTBOUND-001's missing domain-override tier at closure; CAP-045 asserts the
  single-active-connection topology; any future multi-connection capability implements
  domain-override selection first.
- **Threading e2e proof (QA M1) — RULED: recorded follow-up, does not block Slice 1**
  (web-only ownership; AC 6's scoped unit proof exists). Deferred row at closure: worker test
  seeding a parent via the real send route, sending a reply with client-shaped headers, and
  asserting thread-endpoint grouping — home `compose.worker.test.ts` (persistence-on-send has
  zero coverage today) and/or `messages.worker.test.ts`.

### Deferred rows to record at closure

- **D-CAP-044-I** — unbounded `inReplyTo`/`references` (security M2): per-field max in
  `composeRequestSchema` + client cap in `buildReplyContext` that preserves the root (first)
  token. Needs a deliberate cap-value/truncation decision; scenario requires a degenerate
  ~1 MB inbound References header (reply from the UI would be 413-blocked forever).
- **D-CAP-044-J** — threading e2e worker proof (QA M1, ruling above).

### Accepted as-is / routed elsewhere

- Char-vs-byte body-cap mismatch (ApiClient measures UTF-16 units) — pre-existing
  `client.ts` (owned by no slice); the error still surfaces inline; no action this capability.
- New CSS classes (`inbox-compose-entry`, `message-detail-actions`, `compose-confirmation`,
  `compose-body`) — Slice 3 `tokens.css` pass; AC 22's checklist must include them.
- Skeleton shape divergence and reply-mode back-link target — Slice 3 styling-pass judgment.
- `Re:` for an empty parent subject — accepted (honest `Re:` beats a fabricated subject).
- Route `beforeLoad`/`useSearch` wiring proven by construction + `validateComposeSearch` unit
  tests — consistent with the repo's mirror-test convention.
- Closure documentation duty (architecture M2): implementation log must record the
  client-mirror ↔ `THREAD_ROOT_SQL` drift surface (including the dormant `thread_id` tier) and
  the promotion trigger (second consumer → move the helper into contracts).

### Fix-pass outcome (validated 2026-08-24)

Single implementer, criteria (a)–(i) all landed; orchestrator validated the diff file-by-file
and re-ran all gates. Pre-fix failure evidence recorded by the implementer: 6 tests fail against
the old (a)/(b) code, 2 against the old branch order, 1 without the context clear.

Gates after the fix pass: doctor 13/13 · typecheck EXIT=0 · lint EXIT=0 · unit **758/758**
(50 files; 741 baseline + 17 new) · worker **698/702** with exactly the 4 documented
`D-CAP-042-pre-existing-parallelism` failures (verified by name on a second run) · build EXIT=0.

Orchestrator correction to the implementer's residual-gap finding: a references value with a
valid pair but leading garbage (e.g. `garbage <a@b.c>`) still THREADS correctly — the SQL root
is the first bracket token (`substr` from the first `<`), extracted identically from the
reply's verbatim-carried base; only the invariant's whitespace-first-token *letter* diverges
there. The genuinely un-matchable corner is a parent whose tier-3 root is a NON-bracket
in-reply-to value (direct-API compose shape only, pre-existing, worker-structural). Both fold
into **D-CAP-044-I** at closure: the durable fix is server-side normalization of threading
headers at send + ingest (extract/validate bracket tokens), which also carries the size caps.

## Slice 2 review outcome → fix pass (2026-08-24)

Five-way parallel review (architecture, code, security, frontend, QA; none wrote the code).
The implementation was orchestrator-validated before dispatch: 17-file diff exactly matching
the slice-2 ownership row, 12/12 SQL bind slots verified by hand, and all six gates re-run
(doctor 13/13 · typecheck/lint/build EXIT=0 · unit **793/793** (52 files) · worker **711/715**
with exactly the 4 documented `D-CAP-042-pre-existing-parallelism` failures, verified by name).

| Reviewer | Verdict | BLOCKER | HIGH | MEDIUM | LOW |
|---|---|---|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 4 |
| code | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 6 |
| security | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 2 | 2 |
| frontend | ACCEPT-WITH-FOLLOWUPS | 0 | 1 | 2 | 5 |
| QA | ACCEPT-WITH-FOLLOWUPS | 0 | 0 | 2 | 5 |

Orchestrator ruling: **fix pass mandatory.** Architecture H1 and frontend H1 are ship-blocking
for this slice (details below). Code H1 (AC 13 unmet + unruled) is resolved by ruling, not by
code. QA independently confirmed every AC 8–14 clause PASS on evidence — the fix pass closes
deviations, it does not reopen the slice.

### Rulings recorded

- **AC 13 nav-entry clause (code H1 ≡ architecture M2 ≡ QA M2 ≡ frontend M2) — RULED: amend
  the AC; nav deferred as D-CAP-044-K into Slice 3.** The AC's letter ("nav entry visible
  only when the session can read admin surfaces") is unmeetable inside Slice 2: the session
  descriptor (Better Auth `get-session`) carries no role/permission signal, and widening it is
  a cross-module identity/auth decision that belongs to the orchestrator. What IS met and
  test-proven: member → exactly one request → not-authorized panel, no crash loop; all
  authorization server-side. Decision recorded for Slice 3 (contract amendment): add the Admin
  entry to the shared app header, gated by an authenticated probe — a `useQuery` on the
  existing `GET /api/v1/admin/audit-events?limit=1` (`retry: false`, session-stable
  `staleTime`); 200 shows the link, 403 hides it. No new server surface, no session-contract
  widening. The same row covers the Slice 3 users/connections/webhook-events pages (surface
  compounds, mechanism does not).
- **AC 9 index claim (architecture H1 ≡ QA M1) — RULED: fix, don't reword.** Both reviewers
  proved with `EXPLAIN QUERY PLAN` that the single-statement `? IS NULL OR …` shape always
  scans via `audit_events_created_idx` (the plan is chosen at prepare time and never changes
  with bindings), while literal-folded per-shape statements DO select the actor/resource
  indexes. `audit_events` is the one append-only, unbounded-growth table, billed by D1
  rows-read. Fix criterion (a) below adopts the messages-module precedent (bare equality per
  active filter; null-bound slots for the cursor boundary only). Fallback if the fix pass hits
  a blocking complication: reword AC 9 deliberately + a deferred row — never a silent re-check.
- **Upgrade-path seed gap (security M2 ≡ code L6) — RULED: deferred row D-CAP-044-N.**
  `seedRolesAndPermissions` is idempotent but runs only during setup; a deployment installed
  before Slice 2 lacks the `audit.read` row (admin sees 403, failing closed). Fresh installs
  — CAP-045's preview path — seed correctly. First post-launch enum/seed change must ship a
  re-seed mechanism (migration-invoked or scheduled); CAP-045 asserts `audit.read` works on
  the fresh preview.
- **Messages-side INVALID_CURSOR ≥2-page replay (code M2) — RULED: deferred row
  D-CAP-044-L.** `refetch()` on an infinite query replays ALL stored pageParams, so after a
  `CURSOR_SIGNING_KEY` rotation a stored ≥2-page chain fails forever under Retry. Inherited
  verbatim from `InboxListPage.tsx:94-99` (CAP-043 code, outside slice-2 ownership). Slice 2's
  copy is fixed by criterion (e); the messages page fix (resetQueries start-over, or an
  operator dual-accept window) is decided at Slice 3 dispatch or CAP-045.

### Fix criteria (single implementer; slice-2 ownership plus the files granted in (d))

- **(a) Per-combination WHERE composition in `audit-query-repository.ts`** (architecture H1 ≡
  QA M1): stop guarding filter columns with `? IS NULL OR …`. Append bare parameterized
  predicates per ACTIVE filter (`actor_user_id = ?`; `resource_type = ? AND resource_id = ?`
  as a pair; `action = ?`), matching bind order; keep the null-bound slots ONLY for the cursor
  boundary — exactly the `message-read-repository.ts:261-278` precedent. Rewrite the file
  header's "Index shaping" comment (lines 17–21) to describe per-shape composition honestly.
  Behavior-identical: the existing `admin-audit-events.worker.test.ts` suite must pass
  UNMODIFIED. SQL fragments are fixed strings — no user input is ever concatenated.
- **(b) Server-side enum detection point** (code M1 ≡ architecture L2): the repository maps
  rows with `row.action as AuditAction` and nothing ever validates it server-side; a corrupt
  row (out-of-enum action) currently 200s and then takes the client page down with a raw
  ZodError. Add a per-row `auditActionSchema.safeParse` in the repository mapping; on failure
  throw a typed `AuditRowInvalidError`, caught by the route and mapped to
  `DomainError('AUDIT_ROW_INVALID', 500)`. Never silently skip — this is a forensic surface;
  a contract-violating row must be a visible server-side error. Worker test: insert a corrupt
  row directly via D1, request → 500 `AUDIT_ROW_INVALID`.
- **(c) Pair-rule guard** (architecture L3): the exported repository function must throw on a
  half-set resource pair (`resourceType` xor `resourceId`) instead of silently matching
  nothing. Unreachable via the validated route; the exported contract becomes honest. Short
  unit test or worker test.
- **(d) Cursor surface discriminator** (security M1; adjacent code L4/L5) — **ownership
  grant**: the fix pass additionally owns `apps/worker/src/platform/cursor.ts`,
  `apps/worker/src/modules/messages/message-read-repository.ts`, and
  `apps/worker/src/http/routes/messages.worker.test.ts`. Extend `CursorPayload` with
  `readonly surface: string`; `verifyCursor(token, key, expectedSurface)` returns `null` on
  surface mismatch (payload-shape check requires all three fields). Call sites: messages
  signs/verifies with `'messages'` (`message-read-repository.ts:246,327`), audit with
  `'audit-events'` (`audit-query-repository.ts:99,161`). Update the direct `signCursor` use
  in `messages.worker.test.ts:942` and ADD cross-surface rejection tests in both directions
  (messages cursor → audit endpoint → 400 INVALID_CURSOR; audit cursor → messages list → 400).
  Update cursor.ts's header comment (now multi-surface). Deploy-time note: in-flight cursors
  (payload without `surface`) fail verify after this change — accepted pre-launch; CAP-045
  verifies fresh flows.
- **(e) `AuditEventsPage.tsx` error-state restructure** (frontend H1 ≡ frontend M3/M4):
  data-first ordering, same class as Slice 1 fix (c). (1) When page data exists, the filter
  form and the accumulated rows STAY mounted; errors render as a banner above the list — a
  failed background refetch or a failed load-more must never wipe loaded rows. (2) When there
  is NO data and the query errored, render the error panel WITH the filter form still mounted,
  so an invalid `actorUserId` can be corrected and Applied (dead-end Retry fixed — a new
  filter value is a new query key and a fresh first page). (3) The INVALID_CURSOR banner
  offers "Start over" via `queryClient.resetQueries` on the audit key (the old comment claims
  `refetch()` restarts page 1 — false, it replays stored pageParams); fix the comment.
  (4) The not-authorized panel gets `role="status"` (silent today). Tests: invalid uuid →
  error + form mounted → correct + Apply recovers; ≥2 pages loaded then failing fetch → rows
  retained + banner; not-authorized reachable via role query.
- **(f) Fetcher + contract comment honesty** (code M1 note ≡ architecture L1, security L2):
  wrap `auditEventListResponseSchema.parse` in try/catch →
  `ApiError('INVALID_RESPONSE', <readable message>, 0)` (Slice 1 fix (f) convention) instead
  of a raw ZodError; correct the false comment at `admin-queries.ts:78-81` (ApiClient emits
  INVALID_RESPONSE only for non-JSON bodies); soften the `ip` field comment in
  `packages/contracts/src/admin/audit.ts` — no current writer populates it (verified across
  all 14 audit-writer call sites); the field stays reserved.
- **(g) Test hardening** (code L1/L2/L3): worker — a tie-breaker seed (≥2 rows sharing one
  `created_at`, distinct ids, walked across a page edge) pinning the `id DESC` branch; an
  exact-limit tail (4 rows / limit 2 → last full page emits a NON-null cursor, the walk's
  final page is empty with `nextCursor: null`). Web — the accumulation test must assert the
  second fetch URL contains the cursor parameter.

### Deferred rows to record at closure (Slice 2 additions)

- **D-CAP-044-K** — admin discoverability: no nav entry to `/admin` exists for any user
  (admins included); session descriptor carries no role signal. Slice 3 implements the
  probe-gated header entry per the AC 13 ruling above.
- **D-CAP-044-L** — INVALID_CURSOR ≥2-page replay recovery on the messages surfaces
  (`InboxListPage`, thread if applicable): `refetch()` replays stored pageParams; durable fix
  is the (e)-style resetQueries start-over or a `CURSOR_SIGNING_KEY` dual-accept window.
  Surfaced by key rotation; decided at Slice 3 dispatch or CAP-045.
- **D-CAP-044-M** — admin filter state is component-local, not URL search params: refresh or
  a shared link loses filters. Adopt the route `validateSearch` pattern if admin deep-linking
  ever matters.
- **D-CAP-044-N** — upgrade-path re-seed: `audit.read` exists only after
  `seedRolesAndPermissions` re-runs (setup or backfill); fresh installs fine; CAP-045 asserts
  the fresh preview; the first post-launch enum/seed change ships the re-seed mechanism.

### Accepted as-is / routed elsewhere

- security.md `PermissionKey` list lags the code (missing `audit.read`) — orchestrator closure
  duty with the ledger flip (rules-change policy; subagents correctly did not edit it).
- Session header/logout absence — AC 22 (Slice 3) by contract; not a Slice 2 gap.
- Cursor not bound to its filter set (code L4) — house-consistent; post-(d) the residual is
  same-surface cross-filter replay (silent skip, no authz impact — `audit.read` is global).
  Recorded with the cursor-primitive promotion note: it now has two consumers; a third
  consumer or a filter-binding need triggers promoting it into `contracts` with filter
  context in the signed payload.
- Empty-cursor divergence (`?cursor=` → audit 400, messages treats as first page; code L5) —
  harmless inconsistency; align opportunistically at the next cursor.ts touch.
- Worker-flake note (architecture L4): the orchestrator's gate runs name-verify the 4
  documented failures; re-verified after the fix pass.

### Slice 2 fix-pass outcome (validated 2026-08-24)

Two implementer runs: the first was cut off by an infrastructure timeout after completing the
worker-side code of (a)–(d); a continuation run finished (e)–(g), the `:172` narrowing fix,
and every missing test proof. The orchestrator validated the combined diff file-by-file —
per-composition binds, the enum detection point, the pair guard, the surface discriminator
across `cursor.ts` + both call sites, the data-first page restructure — and re-ran all gates.

**Grant acceptance note:** `platform/errors.ts` (`ERROR_CODES.AUDIT_ROW_INVALID`) was edited
outside the explicit fix-pass file list. Accepted post-hoc: it is the mechanically-required
registry home for the new stable error code, the addition is 8 commented lines, and no rule
constrains the file. Recorded here rather than silently absorbed.

Gates after the fix pass: doctor 13/13 · typecheck EXIT=0 · lint EXIT=0 · unit **797/797**
(52 files; 793 baseline + 4 new) · worker **718/722** with exactly the 4 documented
`D-CAP-042-pre-existing-parallelism` failures (verified by name: `migrationsDb R-DATA-004`;
`0015 seeds five legacy users`; `seedRolesAndPermissions` ×2) — +7 worker tests against the
711/715 review baseline · build EXIT=0.

Pre-fix failure evidence (continuation run): 5 web tests fail against the pre-fix
AuditEventsPage (not-authorized `getByRole('status')`, the error-panel form-mounted
assertion, and the three new fix-(e) tests).

Implementer findings routed at closure:
- Worker test files are excluded from `tsc --build` (`apps/worker/tsconfig.json`) — test-only
  type errors (like the pre-continuation missing `surface` field) are invisible to the
  typecheck gate. Process gap; decide at closure whether the gate should typecheck tests.
- The banner's plain Retry refetches every accumulated page sequentially — valid for
  transient failures; same replay class as D-CAP-044-L.
- `admin-error-banner` (and the audit/admin classes generally) have no `tokens.css`
  definitions yet — added to AC 22's Slice 3 checklist.

### Slice 3 contract amendment (recorded 2026-08-24, before Slice 3 dispatch)

- **D-CAP-044-K implementation lands in Slice 3.** A small `AppNav` component
  (`apps/web/src/components/AppNav.tsx`, new) renders an "Admin" link in the mailbox page
  headers, gated by an authenticated probe: `useQuery` over
  `GET /api/v1/admin/audit-events?limit=1` with `retry: false` and a session-stable
  `staleTime` — 200 shows the link, 403/error hides it. No session-contract widening, no new
  server surface (403 probes are request logs, never audit events). Ownership extension:
  the new component plus NON-styling header edits in `InboxListPage.tsx` and
  `MailboxListPage.tsx` to mount it.
- **Cursor-primitive promotion trigger fires (Slice 2 review note):** `listUsers` is the
  THIRD consumer of `platform/cursor.ts`. Honor the recorded trigger: `CursorPayload` (zod
  schema + type) and the closed `CursorSurface` union (`'messages' | 'audit-events' |
  'admin-users'`) move into `packages/contracts`; `platform/cursor.ts` imports them from
  contracts and keeps only the crypto. Ownership extension: `apps/worker/src/platform/cursor.ts`
  (import swap only).
- **AC 22 class checklist** (styling pass must define, at minimum): all `admin-*` classes used
  by the Slice 2 pages (incl. `admin-error-banner`, `audit-*`), `inbox-compose-entry`,
  `message-detail-actions`, `compose-confirmation`, `compose-body`, plus the Slice 3 pages'
  own classes. Every state variant stays distinguishable; no inline styles where a token
  class exists.

## Slice 3 review outcome → fix pass (2026-08-24)

Five independent reviews (none wrote the code). All five verdicts ACCEPT-WITH-FOLLOWUPS;
zero BLOCKERs; one HIGH total. QA re-ran every gate on the review tree: zero divergence —
doctor 13/13 · typecheck 0 · lint 0 · unit **850/850** (57 files) · worker **732/736** with
exactly the 4 documented `D-CAP-042-pre-existing-parallelism` failures verified by name ·
build 0. ACs 15–23 all PASS on QA's clause-by-clause evidence table.

| Reviewer | Verdict | B/H/M/L | Anchor findings |
|---|---|---|---|
| architecture | ACCEPT-WITH-FOLLOWUPS | 0/0/1/6 | local wire schemas (M1); USER_ROW_INVALID accept-as-is (L1); users index (L2); probe comment (L4) |
| code | ACCEPT-WITH-FOLLOWUPS | 0/1/2/6 | **cross-user admin cache retention (H1)**; probe `retryOnMount` (M1); USER_ROW_INVALID grant (M2) |
| security | ACCEPT-WITH-FOLLOWUPS | 0/0/2/6 | admin cache retention (M1); reveal Idempotency-Key (M2); leak regex (L3) |
| frontend | ACCEPT-WITH-FOLLOWUPS | 0/0/2/5 | unread divider CSS (M1); offline-paused false empty (M2); probe gcTime (L1) |
| qa | ACCEPT-WITH-FOLLOWUPS | 0/0/3/6 | loading-state tests (M1); USER_ROW_INVALID (M2); schema promotion (M3) |

Positive evidence worth keeping (full lists in `work/reviews/CAP-044-slice3-review.md`): the
users vertical mirrors the audit precedent at every checked dimension (boundary-only null
slots hand-verified bind-for-bind, per-row `safeParse` detection point, tie-breaker arm,
exact-limit tail, cross-surface rejection both directions); the cursor promotion is the
recorded trigger executed with a single schema definition repo-wide; R-SECRET-003 holds
end-to-end on the reveal flow (confirm-gated POST, one-time display, audit-row-before-return
ordering, five-method console spy + full storage sweep); the Slice 1/2 error-before-data
defect class came back clean on all three new pages with pinned tests; every className
resolves to a tokens.css rule, zero inline styles.

### Rulings recorded

1. **Cross-user admin-data cache retention (code H1 ≡ security M1) — FIX via userId-scoped
   admin data keys.** `admin-queries.ts:96-99` documents the hazard and mitigates it for the
   probe only. Failure: shared workstation — A signs out (SPA; only the session entry is
   nulled), B signs in, opens `/admin/users` by URL → A's cached rows render under the 403
   banner, and the data-first contract + `retry: false` keeps them mounted persistently. The
   alternative — a sign-out cache sweep in `LogoutButton`/`auth-queries.ts` — is rejected:
   it enumerates session-transition events (explicit sign-out misses
   cookie-expiry-then-B-signs-in); userId-scoping is structural and matches the probe
   precedent. The CAP-043 mailbox-query twin is systemic, not silently absorbed →
   **D-CAP-044-O**.
2. **USER_ROW_INVALID — fix now, overruling architecture's accept-as-is.** Architecture's
   substance is correct (the path is unreachable through D1 — `users.status` has a CHECK —
   and the branch is untestable without forbidden D1 mocking, so no new test). But three of
   four reviewers independently recommend the registry grant, Slice 2 set the precedent that
   `errors.ts` registry additions are mechanically-required orchestrator grants, the addition
   is additive and backward-compatible (architecture's own note), and a permanent deferred
   row costs more than the 8-line edit. `platform/errors.ts` granted to the fix pass.
3. **Local zod schemas (architecture M1 ≡ QA M3 ≡ security L5) — DEFER, folded with the
   legacy-lists conversion.** Promoting the schemas while `admin-webhooks.ts` keeps
   hand-mapping responses would create a second source of truth — the exact anti-pattern.
   The promotion + route refactor belong to the same touch → **D-CAP-044-P** (carries
   security's note: the client schemas are non-strict, so a server-side `webhook_secret`
   regression would be silently stripped rather than surfaced).
4. **Reveal endpoint Idempotency-Key (security M2) — deferred row D-CAP-044-Q.** Pre-existing
   CAP-040 code outside every slice's ownership; non-destructive (reveal is a read + audit
   write) but a 5xx-after-commit retry mints two `webhook_secret.reveal` audit rows, and a
   headerless script bypasses the ADR-004 rule entirely.
5. **D-CAP-044-L decided: fixed in this fix pass** (its recorded fork was "Slice 3 fix pass
   or CAP-045"). The start-over pattern now exists on four admin pages; `InboxListPage`
   adopts it and its two false `refetch()` comments are corrected. This **closes
   D-CAP-044-L** — recorded distinct from D-CAP-043-L (the styling-pass row AC 22 closes).
6. **Probe honesty cluster (code M1 + frontend L1 + architecture L4 ≡ security L7) — fixed
   together.** The "exactly one 403 per session" claim is false twice over: errored queries
   refetch on every remount (`retryOnMount` defaults true — AppNav remounts on every
   Inbox ↔ Mailboxes navigation), and the unobserved entry is GC'd after ~5 min so the link
   vanishes then pops in on return. The staleTime rationale also rests on a false premise
   ("role grants need a re-login anyway" — `requirePermission` reads `user_roles` per
   request). `retryOnMount: false` + `gcTime: Infinity` + comments rewritten to the true
   argument (server authorizes per request; the probe is a client-side visibility cache that
   may lag a mid-session grant; reload recovers).
7. **Offline-paused false empty (frontend M2) + loading-state tests (QA M1) — one pattern
   fix, four pages.** `isLoading` (= `isPending && isFetching`) is false while a first fetch
   is paused offline, so every guard falls through to "No users exist yet." — a terminal
   claim about deployment state with zero requests completed. Gate on `isPending`. "Rule
   once, fix everywhere" pulls in Slice 2's `AuditEventsPage` (granted below).

### Fix criteria (single implementer; slice-3 ownership plus the grants after the list)

- **(a) userId-scoped admin data keys.** `adminQueryKeys.{auditEvents,users,connections,
  webhookEvents}` include the session userId exactly like `navProbe`
  (`admin-queries.ts:96-99` precedent). Pages/tests/`admin-queries.test.ts` updated for the
  new key shape. A different user's cached rows become unreachable (different key), closing
  the retention disclosure on all four surfaces.
- **(b) `isPending` loading gate + loading-state tests.** All four admin pages gate their
  loading branch on `query.isPending` (covers paused) instead of `query.isLoading`. Each
  page gets a never-resolving-resolver test asserting the loading UI renders (not the empty
  state, not the error panel).
- **(c) probe correctness.** `useAdminNavProbe`: `retryOnMount: false`, `gcTime: Infinity`;
  comments in `admin-queries.ts` (:349-377), `AppNav.tsx` (:3-12), `AppNav.test.tsx`
  (:8-10) rewritten per ruling 6. New test: 403 → unmount → remount → still exactly one
  probe request.
- **(d) USER_ROW_INVALID registry grant.** `platform/errors.ts`: `ERROR_CODES` gains
  `USER_ROW_INVALID` (comment parity with `AUDIT_ROW_INVALID`); `admin-users.ts` maps
  `UserRowInvalidError` → 500 `USER_ROW_INVALID`. No new worker test (branch unmanufacturable
  without forbidden D1 mocking — documented in the test file).
- **(e) tokens.css.** Unread divider drawn on exactly one side of each boundary (fixes the
  double divider on `[read, unread]` and the missing divider on `[unread, read, read]`);
  add the `admin-connection-status-disabled` variant; correct the comment's domain claim.
- **(f) reveal hygiene.** Reveal mutation `gcTime: 0`; the dialog's stale error clears when
  a retry starts; the "NEVER written to TanStack Query cache" comment amended to the
  gcTime-0 reality; spy-scope comment states the actual swept set. Tests: Cancel fires no
  POST; the admin case (probe 200 → header link) asserted in one mailbox page test in situ.
- **(g) D-CAP-044-L fold-in.** `InboxListPage`: INVALID_CURSOR renders the Start-over
  affordance (`queryClient.resetQueries`) in both the no-data and with-data branches,
  mirroring the admin pages; the two false `refetch()` comments (:19-22, :95-100)
  corrected. Tests for both branches; pin the one-extra-get-session count (QA L5) while in
  the file.
- **(h) worker test hygiene.** `admin-users.worker.test.ts`: leak regex extended to
  `/password|salt|hash|credential|secret|token/i`; duplicated near-empty assertions removed.

Grants beyond slice-3 ownership: `apps/web/src/features/admin/AuditEventsPage.tsx` (+ test)
for (b); `apps/worker/src/platform/errors.ts` for (d); behavioral (non-styling) edits to
`apps/web/src/features/mailbox/InboxListPage.tsx` (+ test) for (g). `auth-queries.ts`,
`LogoutButton.tsx`, `platform/cursor.ts`, `admin-webhooks.ts`: NOT granted — report, don't
edit.

### Deferred rows to record at closure (Slice 3 additions)

- **D-CAP-044-O** — userId-scope the remaining web query keys (mailbox, compose,
  attachments): the CAP-043 twin of fix (a). One systemic sweep, not per-feature patches.
  Includes the companion loading-gate fix: `MessageDetailPage.tsx:96` still gates on
  `isLoading` (same offline-paused false-empty class as fix (b); the inbox twin was fixed in
  this fix pass, the detail page is a CAP-043 file unreviewed here).
- **D-CAP-044-P** — promote `adminConnectionSchema` / `webhookEventDeliverySchema` /
  `webhookSecretRevealSchema` into contracts AND refactor `admin-webhooks.ts` to map through
  them, in the same touch as the legacy phase-1 list conversion (same files). Carries the
  non-strict-silently-strips regression note from ruling 3.
- **D-CAP-044-Q** — the reveal POST mounts no `requireIdempotencyKey` and writes no
  idempotency record (pre-existing CAP-040 file): enforce the mandatory header; batch the
  idempotency record with the audit write.
- **D-CAP-044-R** — `users_created_idx` + boundary composition, only when a deployment's
  user count makes the keyset scan measurable (the index alone would not be selected under
  the `? IS NULL OR` boundary shape).
- **D-CAP-044-S** — the cross-surface cursor matrix's two unproven cells: an
  admin-users-minted cursor rejected by the messages and audit-events verifiers (4 of 6
  cells proven; the discriminator is one shared string compare).
- **D-CAP-044-T** — onboarding hygiene: `modules/onboarding/create-administrator.ts:62`
  reads `FROM users` directly instead of identity's exported `getFirstUser` (pre-existing).

### Accepted as-is / routed elsewhere

- Extra get-session per inbox load (code L2): accepted; now pinned by the (g) count test.
- Users list as `ul/li` rather than a semantic table (QA L3): house-consistent with the
  audit page.
- `components/AppNav` importing from `features/admin` (architecture L5): no rule violated,
  location pinned by the amendment; revisit only if a second cross-feature nav element
  appears (a `features/shell/` home).
- AlertDialog focus trap (frontend L4): the CAP-043 H12 deferral stands; note at closure
  that the reveal confirm extends it (secret-producing, audited action).
- Probe signals `audit.read` only — a custom role with `user.read` but not `audit.read`
  gets no link: correct per the amendment's mechanism while only seeded roles exist
  (recorded on D-CAP-044-K).
- Worker test files excluded from `tsc --build` (Slice 2 fix-pass finding): still open for
  the closure decision.

### Slice 3 fix-pass outcome (validated 2026-08-24)

Single implementer, COMPLETE on all eight criteria. The orchestrator validated every criterion
by direct inspection — key factories + `enabled` gating for (a), all four `isPending` gates for
(b), probe options + rewritten comments for (c), registry + route mapping for (d), one-sided
divider rules for (e), `gcTime: 0` + `onMutate` error-clear for (f), the data-first
InboxListPage with start-over in both branches for (g), regex + dedup for (h) — and re-ran all
six gates.

**Orchestrator follow-through (one token + comment):** the fix pass flagged that
`InboxListPage`'s own loading gate still used `isLoading` (criterion (b) was scoped to the four
admin pages). Applied by the orchestrator directly (`isPending`, same why-comment) — the file
was already granted this slice and the change completes (b)'s rule-once-fix-everywhere. The
same class remains in `MessageDetailPage.tsx:96` (CAP-043 file, unreviewed this slice) →
folded into D-CAP-044-O's scope rather than review-blind-edited.

Gates (orchestrator-run, post-fix): doctor 13/13 · typecheck EXIT=0 · lint EXIT=0 · unit
**863/863** (57 files; 850 baseline + 13 fix-pass tests) · worker **732/736** with exactly the
4 documented `D-CAP-042-pre-existing-parallelism` failures verified by name · build EXIT=0.

Fix-pass findings routed at closure:
- `features/mailbox/InboxError.tsx` is now unused (only its barrel export references it) —
  DELETE at the closure lifecycle resolution (with the barrel line).
- The (b) never-resolving-resolver tests are guards, not pre-fix discriminators (an in-flight
  fetch has `isLoading === true` too); the true discriminator needs
  `onlineManager.setOnline(false)`. Accepted — the gate fix is still proven by inspection, and
  the tests pin the loading contract.
- `gcTime: 0`/`Infinity` retention is not directly asserted (needs fake timers + devtools
  internals); covered indirectly via the remount tests. Accepted.
- The (g) get-session count pin (2 get-session + 1 probe per inbox load) encodes the current
  observer topology; the test comment says a future header session observer legitimately
  changes it. Accepted.
