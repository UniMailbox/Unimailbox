# CAP-047 — Drafts (server-authoritative + IndexedDB working copy)

## Outcome

A user can open a new compose window, type a message, autosave as a draft to the server,
close the browser, reopen the inbox, click the draft, see their typed content, edit further,
and send. The IndexedDB working copy survives browser crashes; the server copy survives
browser exits. Optimistic concurrency (`If-Match: <updated_at>`) prevents two devices from
silently clobbering each other.

Closes INV-002 Phase 3 slices **1.1 (drafts core) + 1.2 (IndexedDB recovery)** — both ship
together per the orchestrator recommendation. Drives AC 2 from
`docs/rebuild/08-roadmap/phase-3-business-completeness.md` ("User saves draft → closes
browser → reopens → draft is on server") and AC 5 partially ("Attachment upload row is
consumed in same transaction as message insert" — the draft-send path becomes the single
entry point for compose send, which CAP-049/050 will compose against).

## Form (locked by user — same pattern as CAP-027/043/046)

- **Server-authoritative** drafts: `messages.status='draft'` is the source of truth.
  `messageStatusSchema` already declares `'draft'` as a status (rank 10; allowed
  transitions `draft → queued | sent` per `ALLOWED_MESSAGE_TRANSITIONS` in
  `packages/contracts/src/index.ts:254`). No new migration needed for the table itself.
- **IndexedDB working copy** (Dexie, same library the inbox already uses) for crash
  recovery. Mirror of the draft's `subject + body_html + body_text + recipients` — the
  server PATCH remains authoritative; IndexedDB is overwritten on every successful PATCH.
- **Optimistic concurrency** on `messages.updated_at` via the `If-Match: <updated_at>`
  header (matches the existing draft-s PUT pattern in `compose.ts`).
- **Atomic send** — `POST /drafts/:id/send` writes the `draft → sent` transition +
  `outbound_jobs` row + `idempotency_records` row in a single D1 batch
  (R-OUTBOUND-006 + CAP-027 batch pattern). The existing `POST /mailboxes/:mailboxId/messages/send`
  route is **either** deprecated or refactored to accept `draftId: string`; the orchestrator
  will pick the simpler path during slice 1.1 sub-task assignment.
- **Idempotency on every mutating route** (ADR-004): `POST /drafts`, `PATCH /drafts/:id`,
  `POST /drafts/:id/send`, `DELETE /drafts/:id` all require `Idempotency-Key`.
- **Audit** — every state transition writes `audit_events` in the same D1 batch:
  `draft.created`, `draft.updated`, `draft.sent`, `draft.discarded`. CAP-046's
  `prepareCreateAuditEvent` pattern; `requestId` threaded from the route
  (`c.get('requestId') ?? null`).
- **No credential in any committed file** (R-SECRET-003). Auth via existing Better Auth
  session cookies + bearer tokens (CAP-042).
- **No SDK introduction**. React Hook Form + Zod + TanStack Query + Dexie (already in
  `apps/web/package.json`). No new dependency.

## Vertical slice

One slice, one capability. Slice boundary: when the schema patches land (if any), the
server use cases + routes + tests pass, the client UI + Dexie working copy + tests pass,
the 5-way review's fix pass lands, and the gate baseline is unchanged.

Closure (the FULL flip) happens when the operator runs the preview gate end-to-end with a
real draft-send round-trip and confirms the operator-evidence folder captures the
working copy + server-side persistence. Ledger-only update; no further code changes.

## Spike verdicts (pre-implementation, BLOCKERs to clear before authoring)

### V1 — `messages.updated_at` is a D1 timestamp TEXT column (R-DATA-001)

**Verdict:** GREEN pending verification. The implementation-log already names
`messages.updated_at` as the optimistic-concurrency token for the existing
`compose.ts` PUT path. The implementer reads `apps/worker/src/database/schema/messages.ts`
to confirm the column type and binding. **No production schema change required.**

### V2 — `If-Match` header parsing (architecture H3)

**Verdict:** GREEN pending verification. `If-Match: <updated_at>` requires parsing the
header value to a stable string (ISO 8601) and binding it to the UPDATE predicate.
`apps/worker/src/http/middleware/` will gain a small `requireIfMatch(updatedAt)` helper
or inline parse at each route. The existing `drafts.worker.test.ts` pattern (when
written) covers both 400 (malformed) and 412 (stale) cases. **No new middleware
required — one-liner at each of 4 call sites.**

### V3 — Dexie table for drafts (architecture H1)

**Verdict:** GREEN pending verification. `apps/web` already uses Dexie for the inbox
working copy (CAP-043 Slice 1). The drafts table is a typed mirror of the server's draft
shape; the existing Dexie schema version + migration pattern applies. **No new library
dependency.**

## Acceptance criteria

### Server (use cases + routes + persistence)

- [ ] 1. **`POST /api/v1/mailboxes/:mailboxId/drafts`** — body validates as `createDraftSchema`
  from `packages/contracts` (zod: `subject: string ≤998`, `body_text: string ≤65536`,
  `body_html: string? ≤131072`, `to: EmailAddress[] ≤50`, `cc?: EmailAddress[] ≤50`,
  `bcc?: EmailAddress[] ≤50`). Authorization: `mailboxes.assertCan(actorUserId,
  mailboxId, 'send')` (sender or higher per the mailbox matrix in
  `.claude/rules/security.md`). Writes `messages.status='draft'` +
  `message_recipients` (zero rows — drafts have no recipients yet, OR rows for to/cc/bcc
  if the user wants recipient validation now; orchestrator picks the simpler path) +
  `idempotency_records` in one D1 batch (R-OUTBOUND-006). Audit row `draft.created`
  folded into the same batch. Returns `201` with `Location: /api/v1/drafts/:id` and the
  draft's `updated_at` (RFC 3339 string).
- [ ] 2. **`GET /api/v1/drafts/:id`** — returns the draft shape (`subject`, `body_text`,
  `body_html`, `to`, `cc`, `bcc`, `updated_at`, `created_at`, `status='draft'`).
  Authorization: `mailboxes.assertCan(actorUserId, mailboxId, 'read')`. 404 if not
  found, 403 if not authorized. No `If-Match` required (read).
- [ ] 3. **`PATCH /api/v1/drafts/:id`** — body validates as `updateDraftSchema` (same
  fields as create but all optional). Header `If-Match: <updated_at>` required. UPDATE
  predicate includes `AND updated_at = ?` to defeat the TOCTOU race; returns 412
  `STALE_IF_MATCH` on stale concurrency. Writes the updated row +
  `idempotency_records` + audit `draft.updated` in one D1 batch. Returns 200 + new
  `updated_at`.
- [ ] 4. **`POST /api/v1/drafts/:id/send`** — body validates as `sendDraftSchema`
  (`Idempotency-Key` enforced; no body required beyond header). Writes
  `messages.status='draft' → 'sent'` (state machine: rank advances 10 → 60 — uses
  `updateMessageStatus` from CAP-029 with allowed-froms `['draft']` per
  `ALLOWED_MESSAGE_TRANSITIONS` — verified direction guard per CAP-030) +
  `outbound_jobs` row (per CAP-028, with `idempotency_key = canonical_message_id`,
  R-OUTBOUND-004) + `idempotency_records` + audit `draft.sent` in **one** D1 batch.
  Returns 202 with `Location: /api/v1/messages/:id`. Idempotency replay returns the
  identical response; same key + different body returns 409.
- [ ] 5. **`DELETE /api/v1/drafts/:id`** — sets `messages.status='draft' → 'deleted'` (or
  a hard `DELETE FROM messages WHERE id = ?` — orchestrator picks the simpler path
  during slice assignment). Audit `draft.discarded`. Same D1 batch.
- [ ] 6. **Inbox includes drafts folder** — the existing `/mail/:mailboxId` filter UI
  gains a "Drafts" button alongside Inbox / Sent. Drafts are messages with
  `status='draft'` in the mailbox; the existing `messages.list` use case gains an
  optional `?status=draft` query parameter (the orchestrator picks whether this lives
  in the existing route or a separate `drafts.list` route).
- [ ] 7. **Compose route refactor** — `POST /api/v1/mailboxes/:mailboxId/messages/send`
  is either (a) deprecated and returns 410 GONE with `Sunset` header pointing at
  `/drafts/:id/send`, or (b) refactored to internally call the same use case as
  `POST /api/v1/drafts/:id/send` with `draftId` optional. Orchestrator picks the
  simpler path.

### Worker tests (apps/worker/test/drafts.worker.test.ts + extensions)

- [ ] 8. Worker-pool tests cover each AC 1–7 end-to-end:
  - 8a: create → returns 201 + `updated_at`; replay (same key + same body) returns 201
    with same id; same key + different body returns 409 `IDEMPOTENCY_KEY_REUSED`.
  - 8b: PATCH without `If-Match` → 400 `IF_MATCH_REQUIRED`; PATCH with stale
    `If-Match` → 412 `STALE_IF_MATCH`; concurrent PATCH loses to winner (the loser's
    UPDATE rows-affected is 0 → 412). R-MESSAGE-012 enforced (draft cannot transition
    to `sending`).
  - 8c: send → outbound_jobs row + messages.status='sent' + idempotency_records row
    all written; `providerMessageId` round-trip is NOT asserted here (that's a
    CAP-029/045 invariant already proven).
  - 8d: send without permission (`viewer` role trying to send) → 403 PERMISSION_DENIED.
  - 8e: GET drafts returns 200 with shape conformance; IDOR test (actor A reads
    actor B's draft) → 404 MESSAGE_NOT_FOUND (the no-leak 404 pattern per CAP-043).
  - 8f: DELETE draft → 204; subsequent GET returns 404.
- [ ] 9. The four documented D-CAP-042 pre-existing failures are unchanged
  (`0015_credential_backfill` + `admin.seedRolesAndPermissions` ×2 + one more).

### Client (apps/web)

- [ ] 10. **`/mail/:mailboxId/new`** — composes a new message; the editor saves to
  IndexedDB on every keystroke (debounced 1.5s) AND fires a `POST /drafts` on first
  edit. Server returns the draft's id + `updated_at`; subsequent edits PATCH the draft
  with `If-Match`. React Hook Form + Zod; no `document.execCommand`.
- [ ] 11. **`/mail/:mailboxId/draft/:draftId`** — loads the draft (server fetch with
  `GET /drafts/:id`); renders the editor with the loaded `subject + body_text +
  recipients`. Closing the route returns to `/mail/:mailboxId?folder=drafts`.
- [ ] 12. **Autosave indicator** — the editor shows "Saving…" / "Saved 3s ago" based
  on the last successful PATCH's `updated_at`. Stale `If-Match` on the server response
  surfaces a yellow "Server has a newer version" banner with a "Reload" button that
  re-GETs and discards local edits.
- [ ] 13. **Dexie schema** — `apps/web/src/lib/draft-cache.ts` opens a Dexie database
  with a `drafts` table (key: `draftId`, indexes: `updatedAt`, `mailboxId`). On every
  successful PATCH, mirror the draft's shape into the table. On `/mail/:mailboxId` open,
  if IndexedDB has a draft whose `updatedAt > server's updatedAt`, surface a
  "Recover unsaved draft from this device" prompt with confirm/discard.
- [ ] 14. **Drafts folder UI** — `/mail/:mailboxId?folder=drafts` lists drafts (the
  same `MessageListItem` shape as the inbox; subject + recipient + updated_at). Click
  navigates to `/mail/:mailboxId/draft/:draftId`.
- [ ] 15. **Send from draft** — the editor's "Send" button calls
  `POST /drafts/:id/send`; on 202 success, navigates to the sent message detail; on
  412, re-prompts with the conflict banner; on 403/404, surfaces an error toast.
- [ ] 16. **Discard from draft** — the editor's "Discard" button calls
  `DELETE /drafts/:id`; on 204, navigates to `/mail/:mailboxId?folder=drafts`.
- [ ] 17. **Auth loading/unauthorized/error states** — per `.claude/rules/coding.md`
  + the web vertical-slice contract (CAP-043): loading state on every route, error
  state with retry, unauthorized state with sign-in CTA. No silent failures.

### Gates (orchestrator-run subset)

- [ ] 18. `pnpm scaffold doctor` 15/14 (check #15 `drafts-route-present` added per
  CAP-045's check-#14 pattern).
- [ ] 19. `pnpm typecheck` clean.
- [ ] 20. `pnpm lint` clean.
- [ ] 21. `pnpm test:unit` all green — count grows by the new contract tests
  (`drafts.test.ts` server-side unit, `draft-cache.test.ts` Dexie unit).
- [ ] 22. `pnpm test:worker` — 4 documented D-CAP-042 failures unchanged; the new
  `drafts.worker.test.ts` + extensions to `compose.worker.test.ts` (if the orchestrator
  picks path 7a/7b) all pass.
- [ ] 23. `pnpm build` EXIT=0.
- [ ] 24. **No new dependency added** to `apps/web/package.json` or `apps/worker/package.json`.

### Closure (operator-driven, not orchestrator-runnable)

- [ ] 25. Operator runs `pnpm scaffold deploy --environment=preview`, exercises the
  end-to-end draft flow on the deployed Worker: open `/mail/:mailboxId/new`, type
  content, observe autosave indicator, force browser kill, reopen browser, see draft
  restored from server, edit further, send, see outbound message in Sent folder.
  Captures evidence in `work/reviews/CAP-047-evidence-<OPERATOR>-<YYYY-MM-DD>/`.

## File ownership

| File | Owner |
|---|---|
| `work/active/CAP-047-drafts/task.md` | Orchestrator (this contract) |
| `apps/worker/src/http/routes/drafts.ts` (NEW) | `implementer-cap047` |
| `apps/worker/src/modules/messages/draft-use-cases.ts` (NEW) | `implementer-cap047` |
| `apps/worker/src/modules/messages/draft-repository.ts` (NEW — read + If-Match UPDATE) | `implementer-cap047` |
| `apps/worker/test/drafts.worker.test.ts` (NEW) | `implementer-cap047` |
| `apps/worker/src/http/routes/compose.ts` (refactor for 7a/7b) | `implementer-cap047` (surgical edit) |
| `apps/worker/src/database/schema/messages.ts` (if `updated_at` index missing) | `implementer-cap047` (NEW migration `0018_drafts_optimistic_concurrency.sql` if needed) |
| `apps/worker/src/http/router.ts` (wire drafts routes) | `implementer-cap047` |
| `apps/web/src/lib/draft-cache.ts` (NEW — Dexie schema + recovery) | `implementer-cap047` |
| `apps/web/src/routes/mail.$mailboxId.new.tsx` (NEW — compose editor) | `implementer-cap047` |
| `apps/web/src/routes/mail.$mailboxId.draft.$draftId.tsx` (NEW — draft editor) | `implementer-cap047` |
| `apps/web/src/routes/mail.$mailboxId.tsx` (drafts folder button) | `implementer-cap047` |
| `apps/web/src/hooks/useDraftAutosave.ts` (NEW) | `implementer-cap047` |
| `packages/contracts/src/index.ts` (`createDraftSchema` + `updateDraftSchema` + `sendDraftSchema`) | `implementer-cap047` |
| `packages/contracts/src/index.test.ts` (zod schema tests) | `implementer-cap047` |
| `scripts/doctor.ts` (new check #15) | `implementer-cap047` |
| `scripts/doctor.test.ts` (new check #15 test) | `implementer-cap047` |
| `docs/rebuild/capability-ledger.md` (CAP-047 row) | Orchestrator (closure) |
| `docs/rebuild/implementation-log.md` (closure entry) | Orchestrator (closure) |

## Review surface (5-way, parallel after implementer COMPLETE)

| Reviewer | Focus |
|---|---|
| `architecture-reviewer` | Did the implementer honor V1/V2/V3 spike verdicts? Does the optimistic-concurrency predicate (`AND updated_at = ?`) defeat TOCTOU? Is the `compose.ts` refactor choice (7a vs 7b) justified? Does the Dexie schema version upgrade safely (no on-existing-tables regression)? |
| `code-reviewer` | Zod schema correctness; `If-Match` parse edge cases (RFC 7232 quoted-string, weak vs strong ETags); Dexie transaction isolation; React Hook Form + TanStack Query integration; no `document.execCommand`; no `any`. |
| `security-reviewer` | IDOR coverage (8e); no body or recipient PII in audit chain; `If-Match` strictness (no fallback to `If-None-Match`); rate-limit on draft autosave (debounce + max PATCH rate); CR/LF injection in subject/body. |
| `qa-reviewer` | AC traceability — every AC 1–25 mapped to at least one `it()`. 4 documented worker failures still at baseline. Operator runbook commands work against current `scripts/deploy.ts`. Browser state coverage: loading / error / unauthorized / retry for every route. |
| `frontend-reviewer` | No `document.execCommand`. React Hook Form + Zod + TanStack Query patterns match the rest of `apps/web`. Dexie migration safety. Editor autosave UX (no data loss on disconnect). Mobile / tablet responsive layout per CAP-043 + CAP-044 patterns. |

After review, single-implementer fix pass on the consolidated criteria; then closure.

## Exit-criteria mapping (INV-002 → ACs closed)

| Phase 3 AC | Where it lands |
|---|---|
| AC 2 (draft survives browser close) | AC 11 (load server draft) + AC 13 (Dexie recovery) |
| AC 5 (atomic consume; partial) | AC 4 (draft-send atomic batch) — the path CAP-049 will compose against |
| AC 3, AC 4, AC 1, AC 6 | Future CAP-049/050/051/052/053 |

## Risks + open questions

- **The `messages.status='deleted'` vs hard-DELETE decision (AC 5) affects audit replay.**
  Hard DELETE simplifies the schema; `status='deleted'` keeps the audit chain complete.
  The orchestrator picks the simpler path during slice assignment and the contract is
  locked at that point. Tracked as a slice-decision; the user can override before
  implementation begins.
- **The compose route refactor (AC 7) is the largest single change.** Path 7a (deprecate
  the old route) is more code but zero-risk for existing clients. Path 7b (refactor to
  call the same use case) is less code but requires both routes to be tested. The
  orchestrator picks; CAP-029's existing `processOutboundJob` already calls
  `updateMessageStatus` so the path 7b refactor is well-precedented.
- **`messages.updated_at` index** — if the schema lacks an index on `updated_at`,
  AC 8b's concurrent-PATCH test will flake under heavy parallel writes. The
  implementation-log entry from CAP-043's inbox already asserts the index exists; V1 spike
  verifies before authoring. If missing, a one-line migration `0018_drafts_optimistic_concurrency.sql`
  adds it.
- **Dexie schema versioning** — the existing Dexie schema version (used by the inbox
  working copy) is `1` per CAP-043 Slice 1. Adding a drafts table requires either
  bumping to `2` with a migration or starting a separate `unimailbox-drafts` database.
  The implementer picks; the simpler path is a separate database (no version bump
  cascade).
- **Operator preview evidence** — the operator runbook Step 7 (repeat deploy) and
  Step 4 (real inbound round-trip) are CAP-045's. CAP-047's evidence folder is new:
  the operator drafts a real draft, kills the browser, reopens, confirms the draft is
  restored, and edits/sends. Pasting the screenshots + the wrangler tail sample into
  `work/reviews/CAP-047-evidence-<OPERATOR>-<YYYY-MM-DD>/` is the FULL closure.

## Out of scope (deferred rows recorded at closure)

- D-CAP-047-A — `compose.ts` `new Response(...)` X-Request-Id propagation (rides with
  D-CAP-046-M; Hono header propagation).
- D-CAP-047-B — Draft upload attachments (rides with CAP-049/050).
- D-CAP-047-C — Draft sharing (one draft, multiple authors; rides with CAP-052/053).
- D-CAP-047-D — Draft autosave rate-limit (debounce + max PATCH rate); a follow-up
  capability once real-world PATCH rates are measured.

(Names provisional; orchestrator renames against the next capability's task ID.)