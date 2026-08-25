# INV-002 — Phase 3 decomposition (drafts, attachments, sharing, folders, stars)

## Why this exists

INV-001 closed Phase 2 (commit `8b1406f` 2026-08-25). Per `docs/rebuild/execution-plan.md:156`,
Phase 3 is now decomposable. This document enumerates Phase 3's vertical slices, allocates CAP
IDs, names the ordering rationale, and identifies the first-slice contract that the orchestrator
will hand to an implementer.

## Phase 3 source

- `docs/rebuild/08-roadmap/phase-3-business-completeness.md` — 5 scope items, 6 acceptance
  criteria. **Authoritative scope.** This document does not redefine or extend it.
- Existing repository state: CAP-027–046 all `Implemented`; migrations through `0017`;
  the `drafts` table is declared in `database/schema/messages.ts` but unused; `attachments`
  has `message_attachments` + `attachment_uploads` tables declared but no routes ship;
  `mailbox_members` table exists (Phase 1 stub) but no routes use it; `message_user_state`
  holds per-user state but only `read` + `soft_deleted` rows exist (CAP-043 Slice 3);
  `messages.status` enum has `draft` value unused in code today.

## Phase 3 acceptance criteria (from the roadmap)

1. User uploads 5 MB PDF → attaches to compose → sends → recipient downloads.
2. User saves draft → closes browser → reopens → draft is on server.
3. Owner shares mailbox with viewer → viewer reads; viewer cannot delete.
4. Two users star the same message; starring one does not affect the other.
5. Attachment upload row is consumed in same transaction as message insert.
6. Unused upload expires after 1 hour and is cleaned by scheduled job.

## Phase 3 scope items → vertical-slice grouping

The five scope items do not map 1:1 to capabilities. The vertical-slice rule
(`.claude/rules/agent-collaboration.md` §"Rule of One") is "one vertical slice (domain →
persistence → use case → API → UI → tests) at a time. Never a horizontal 'all the backend,
then all the frontend' split." So the natural grouping is by user flow, not by file.

### Capability 1 — Drafts (CAP-NNN: server-authoritative drafts + IndexedDB working copy)

**Vertical slice 1.1 — Draft schema + atomic send** (`CAP-XXX-drafts-core`)

- DB: `drafts` table (or `messages.status='draft'` per the roadmap's existing shape);
  `messages.updated_at` indexed for `If-Match` optimistic concurrency.
- Use case: `drafts.create` (init draft), `drafts.update` (PATCH with `If-Match`),
  `drafts.send` (atomic `draft → sent` + outbound job in one D1 batch — R-OUTBOUND-006
  precedent; refactor `compose.ts` to accept `draftId` or build draft-shaped input).
- API: `POST /api/v1/mailboxes/:mailboxId/drafts`, `PATCH /api/v1/drafts/:id` (with
  `If-Match`), `POST /api/v1/drafts/:id/send`.
- UI: `/mail/:mailboxId/draft` page (load + autosave + send button).
- Tests: each transition in the state machine (draft → sent, draft → draft via PATCH,
  concurrent PATCH loses to winner, send-from-draft writes outbound job in same batch).

**Vertical slice 1.2 — IndexedDB working copy** (rides with 1.1 or a separate `CAP-XXX-drafts-recovery`)

- `apps/web/src/lib/draft-cache.ts` — Dexie table mirroring server drafts; autosave debounced
  on `PATCH`; recovery on `/mail/:mailboxId` open when IndexedDB has fresher content than
  server (clock skew case).
- Tests: `draft-cache.test.ts` (Dexie stub) + a route test that asserts server wins on
  explicit "load server" action.

**Acceptance criteria closed:** AC 2 ("draft survives browser close"), AC 5 partially
(atomic message insert from draft path).

### Capability 2 — Attachments (CAP-NNN: R2 presigned PUT, compose-attach, download)

**Vertical slice 2.1 — Upload trigger + ownership/expiry/size** (`CAP-XXX-attachments-upload`)

- DB: `attachment_uploads` table already declared; add R2 key + `expires_at` + `size_bytes`.
  Status: `pending` → `uploaded` → `consumed` (or `expired`).
- Use case: `attachments.requestUpload` (returns presigned R2 PUT URL with
  `expires_in = 3600s`, `max_size = 64 MiB`, ownership check against
  `(actor_user_id, mailbox_id)`).
- API: `POST /api/v1/mailboxes/:mailboxId/attachments/upload-url` (returns
  `{uploadId, putUrl, expiresAt, maxSizeBytes}`).
- Worker: `attachments/:id/download` route with authorization check
  (`mailboxes.assertCan(actorUserId, mailboxId, 'read')` + ownership-of-upload check).

**Vertical slice 2.2 — Compose-attach + atomic consume** (`CAP-XXX-attachments-compose`)

- UI: file picker on compose; uploads via presigned URL; attaches by `attachmentUploadId[]`.
- Use case: `compose.send` accepts `attachmentUploadIds[]`; on the same D1 batch as the
  `messages` + `outbound_jobs` + `idempotency_records` writes (R-OUTBOUND-006 + AC 5),
  consumes each upload row (`pending → consumed`, R2 key promoted to `message_attachments`).
- API: existing `POST /api/v1/mailboxes/:mailboxId/messages/send` gains
  `attachmentUploadIds: string[]` (≤10 per message, ≤64 MiB each — 50 MiB inline cap).
- Tests: AC 5 (same-batch consume), AC 1 (full upload-attach-send-download round-trip with
  worker-pool's R2 binding).

**Vertical slice 2.3 — Download + inline image CID** (`CAP-XXX-attachments-render`)

- API: `GET /api/v1/attachments/:id/download` (with auth + ownership).
- Worker: stream from R2; `Content-Disposition` set; for `image/*` mime, the message
  detail UI rewrites `cid:` references to the download URL.
- Scheduled entrypoint: `purgeExpiredAttachmentUploads` (the 1-hour expiry — AC 6).
  Extends `apps/worker/src/entrypoints/scheduled.ts` (D-CAP-046-G coverage).
- Tests: AC 6 (cleanup cron), `cid:` rewrite unit test in `apps/web`.

**Acceptance criteria closed:** AC 1, AC 5, AC 6.

### Capability 3 — Mailbox sharing + folders + stars (CAP-NNN: `mailbox_members` CRUD + per-user state)

**Vertical slice 3.1 — Sharing backend + permission gate** (`CAP-XXX-mailbox-sharing`)

- Use case: `mailboxMembers.invite`, `mailboxMembers.remove`, `mailboxMembers.list`.
  Authorization: `mailboxes.assertCan(actorUserId, mailboxId, 'manage_members')`.
- API: `POST /api/v1/mailboxes/:mailboxId/members`,
  `DELETE /api/v1/mailboxes/:mailboxId/members/:userId`,
  `GET /api/v1/mailboxes/:mailboxId/members`. New permission key
  `mailbox.share` (added to `PermissionKey` enum per `.claude/rules/security.md`).
- Idempotency on `invite` (R-OUTBOUND-004 pattern); audit row `mailbox.member_added` /
  `mailbox.member_removed` folded into the same D1 batch as the business write
  (CAP-046 pattern).

**Vertical slice 3.2 — Sharing UI + folders views** (`CAP-XXX-mailbox-shared-ui`)

- UI: `/mail/:mailboxId/members` admin page; invite-by-email form; per-member role select.
- Folders: filter buttons on `/mail/:mailboxId` (Inbox / Sent / Drafts / Archive / Trash);
  reuses CAP-043 inbox layout.
- Stars: per-user star toggle on `MessageDetailPage`; reads/writes `message_user_state`
  with `kind='starred'` (the table already holds `read` + `soft_deleted` rows).

**Vertical slice 3.3 — Sharing tests + IDOR coverage** (`CAP-XXX-mailbox-shared-tests` or rides with 3.1)

- IDOR tests: actor A invites to mailbox B → 403; viewer cannot `delete` mailboxes; sender
  cannot `rename`.
- Per-user star independence: actor A stars message → actor B's `starred` state is `false`.
  AC 4 explicitly tested.

**Acceptance criteria closed:** AC 3, AC 4.

## Allocation table

| Slice | Working name | Depends on | CAP ID |
|---|---|---|---|
| 1.1 | Drafts core (schema + send) | CAP-040 + CAP-043 | TBD-047 (next available) |
| 1.2 | Drafts recovery (IndexedDB) | 1.1 | TBD-048 |
| 2.1 | Attachments upload (R2 + ownership) | CAP-031 (1 MB limit) + R2 binding | TBD-049 |
| 2.2 | Attachments compose (atomic consume) | 1.1 + 2.1 | TBD-050 |
| 2.3 | Attachments render + scheduled cleanup | 2.2 | TBD-051 |
| 3.1 | Sharing backend | CAP-040 + CAP-043 | TBD-052 |
| 3.2 | Sharing UI + folders + stars | 3.1 + CAP-043 | TBD-053 |
| 3.3 | Sharing IDOR tests | 3.1 | rides with 3.1 |

CAP-036 (JSON normalization, R-DATA-005 strictness) and CAP-029-A atomicity
follow-up remain available as Phase 2 closure candidates that could be inserted
between 1.1 and 2.1 if the user wants Phase 2 fully closed before Phase 3 starts.

## Ordering rationale

**Drafts first** (1.1) because:
- It is the smallest self-contained vertical slice — schema, use case, API, UI, tests.
- It exercises the existing `messages` + `outbound_jobs` + `idempotency_records` batch
  pattern (CAP-027) under a new transition (`draft → sent`), giving the orchestrator a
  chance to validate the refactor that lets `compose.send` accept a `draftId`.
- It is the most user-visible Phase 3 feature; demos well in a preview deployment.

**Attachments second** (2.1–2.3) because:
- They depend on the compose surface that 1.1 refactors.
- They introduce the only new Cloudflare binding for Phase 3 (R2 — already wired in
  CAP-039's deploy substrate, but unused).
- The atomic-consume invariant (AC 5) is a Phase 2-style correctness concern; testing it
  belongs with the same batch pattern 1.1 already exercises.

**Sharing third** (3.1–3.3) because:
- It depends on `mailboxes.assertCan` (CAP-043) for viewer/sender/admin semantics.
- It enables Phase 4 legacy data import (multiple users per mailbox).
- It can defer Phase 4 readiness without blocking the other two capabilities.

## First-slice contract candidate

If the user picks **drafts first**, the contract is:

```
work/active/CAP-047-drafts/task.md
```

Rough acceptance criteria (provisional; locked when the implementer picks it up):

- [ ] AC 1.1.a — `messages.status='draft'` write path (`POST /api/v1/mailboxes/:mailboxId/drafts`)
  asserts idempotency record + draft row in one D1 batch (R-OUTBOUND-006 pattern).
- [ ] AC 1.1.b — `PATCH /api/v1/drafts/:id` with `If-Match: <updated_at>` returns 412 on stale
  concurrency; 200 + new `updated_at` on success; no `outbound_jobs` write.
- [ ] AC 1.1.c — `POST /api/v1/drafts/:id/send` writes `messages.status='draft'` → `'sent'` +
  outbound job + idempotency record in one D1 batch; idempotency 409 on key reuse with
  different body; replay returns identical response.
- [ ] AC 1.1.d — Worker-pool tests cover: 1.1.a/b/c; concurrent PATCH loses to winner; missing
  `If-Match` 400; draft state machine forbids `draft → sending` (R-MESSAGE-012).
- [ ] AC 1.1.e — `apps/web/src/routes/mail.$mailboxId.draft.tsx` renders the draft editor with
  autosave (debounced 1.5s) + send button + "discard" button (DELETE the draft).
- [ ] AC 1.1.f — Doctor check #15 (or extension of #14) verifies the draft route + UI exist.

Front-end + back-end reviews required; security review required (authz + IDOR + audit
chain). Architecture review optional (slice is mechanical; matches CAP-027/043 patterns).

## Open questions for the user

1. **First slice:** drafts, attachments, or sharing? Drafts is the recommended default.
2. **CAP-036 first?** The audit recommends v1 ships without JSON normalization. If the user
   disagrees, CAP-036 is a single backend-only slice that could run between drafts and
   attachments.
3. **Slice 1.2 (IndexedDB working copy) as separate CAP or rides with 1.1?** Rides-with is
   the orchestrator's recommendation — the IndexedDB code is small (≤150 lines) and tightly
   coupled to the server PATCH shape.
4. **Phase 4 dependency:** does sharing need to ship before legacy import is exercised
   end-to-end, or can Phase 4 stage "import to owner-only mailbox" for the v1 cutover?

## No code changed

This is a decomposition document. Per `.claude/rules/agent-collaboration.md`
§Handoff format, "no code changed" is the explicit disposition.