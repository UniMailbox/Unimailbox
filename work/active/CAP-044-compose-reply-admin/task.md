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

- [ ] 8. `audit.read` is added to the closed `PermissionKey` enum in `packages/contracts`
  (D-CAP-044-D) with enum-closure tests updated; the seeded `administrator` role gains it; the
  `member` role does not.
- [ ] 9. An audit-event query repository in `modules/admin` filters composable:
  `actorUserId?`, `resourceType?` + `resourceId?` (pair), `action?`, each optional; ordered
  `created_at DESC, id DESC`; cursor-paginated via `platform/cursor.ts`; served by the existing
  `audit_events_actor_idx` / `audit_events_resource_idx`.
- [ ] 10. `GET /api/v1/admin/audit-events` — `requirePermission('audit.read')` + authn; query
  params validated with a zod schema from contracts; response `{ data: { items: AuditEvent[],
  nextCursor } }`; `metadata` returned as the stored JSON string (opaque, `string | null`).
- [ ] 11. Worker tests: anonymous 401; member (no `audit.read`) 403; administrator 200; filter by
  actor; filter by resource pair; combined actor+resource; cursor walk across a page edge returns
  disjoint pages and a null cursor at the end; empty result → `{ items: [], nextCursor: null }`;
  every returned row's shape matches `auditEventSchema` (contracts test parity).
- [ ] 12. `auditEventSchema` + `auditEventListResponseSchema` + the query-params schema live in
  `packages/contracts` (admin/audit.ts or index.ts per existing layout) with tests.
- [ ] 13. Web: an `/admin` section (session-guarded; nav entry visible only when the session can
  read admin surfaces — hide, do not 403-crash, for members) with an AuditEventsPage: actor and
  resource filters, action filter, cursor pagination ("load more"), and explicit
  loading/error/empty states.
- [ ] 14. Web tests: audit query hook builds the right query string per filter combination;
  member-without-permission renders the not-authorized state (no API crash loop); pagination
  accumulates rows.

### Slice 3 — admin users + webhook metadata + styling

- [ ] 15. The identity module exports a public `listUsers` read (cursor-paginated, ordered
  `created_at DESC, id DESC`) — the ONLY new code inside `modules/identity`; the `users` table
  stays identity-owned.
- [ ] 16. `GET /api/v1/admin/users` — `requirePermission('user.read')`; response rows carry id,
  email, display name, created_at (as stored), and account status IF a status column exists — and
  NEVER password-hash or credential columns; a worker test asserts the response JSON contains no
  key matching /hash|credential|secret|token/i.
- [ ] 17. Worker tests for users list: anonymous 401; member 403; administrator 200; cursor walk;
  empty deployment edge (only the admin themselves); shape matches the contracts schema.
- [ ] 18. `userListItemSchema` + list response schema in `packages/contracts` with tests.
- [ ] 19. Web UsersPage: table with the list fields, cursor pagination, loading/error/empty
  states; linked from the admin section nav.
- [ ] 20. Web ConnectionsPage over `GET /api/v1/admin/connections` (`webhook_event.read`):
  connection rows with provider, status, `webhookConfigured`, `webhookUrl`; a reveal action calls
  the existing `POST .../webhook-secret/reveal` behind a confirm dialog, displays the value once
  with an explicit "this is shown once / the reveal is audited" note, and never logs or persists
  it (asserted in a web test via the logging spy pattern used in CAP-043).
- [ ] 21. Web WebhookEventsPage over `GET /api/v1/admin/webhook-events`: rows with delivery
  metadata as the API returns them; loading/error/empty states.
- [ ] 22. Styling pass (closes D-CAP-043-L): `tokens.css` gains the real class definitions for
  the inbox surfaces (`.inbox-*`), the composer, and the admin pages; every state variant
  (default/loading/error/empty) remains distinguishable after styling; no inline style props
  where a token class exists.
- [ ] 23. Gates (orchestrator-run after each fix pass): `pnpm scaffold doctor` 13/13;
  `pnpm typecheck` clean; `pnpm lint` clean; `pnpm test:unit` all green (count grows by the new
  tests); `pnpm test:worker` green except exactly the 4 documented
  `D-CAP-042-pre-existing-parallelism` failures; `pnpm build` EXIT=0.

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
