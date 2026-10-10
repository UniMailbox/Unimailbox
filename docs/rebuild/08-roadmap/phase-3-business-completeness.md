# Phase 3 — Complete Core Business

## Business goal

The second and third core flows work: drafts and attachments.

## User value

Users can save drafts locally + server-side, attach files, share mailboxes.

## Scope

- **Attachments**:
  - `attachment_uploads` table with presigned R2 PUT URLs.
  - Triggers validate ownership + status + expiry + size match.
  - `attachments/:id/download` API with authorization check.
  - Inline image CID rewriting.
- **Drafts**:
  - Server-authoritative drafts via `messages.status='draft'` + `mailbox_messages.folder='drafts'`.
  - Optimistic concurrency on `messages.updated_at` (`If-Match` header).
  - IndexedDB-backed local working copy (crash recovery only).
  - `POST /drafts/:id/send` atomically transitions draft → sent.
- **Sharing**:
  - `mailbox_members` CRUD (viewer / sender / admin).
  - Per-user read/star/delete state on `message_user_state`.
  - `mailbox:share` permission gates member management.
- **Folders**: sent, drafts, archive, trash views.
- **Stars**: per-user star toggle.

## Out of scope

Search, bulk operations, advanced admin features.

## Acceptance criteria

```text
[ ] User uploads 5 MB PDF → attaches to compose → sends → recipient downloads.
[ ] User saves draft → closes browser → reopens → draft is on server.
[ ] Owner shares mailbox with viewer → viewer reads; viewer cannot delete.
[ ] Two users star the same message; starring one does not affect the other.
[ ] Attachment upload row is consumed in same transaction as message insert.
[ ] Unused upload expires after 1 hour and is cleaned by scheduled job.
```

## Key technical decisions

- Attachment R2 key format: `attachments/{uuid-v4}.{safe-ext}`.
- Max attachment size: 64 MiB.
- Max attachments per message: 10.
- Inline image cap: 50.
- Upload TTL: 1 hour.
- Draft version token: ISO  timestamp.

## Migration from legacy

- The new system serves all user-facing routes on its preview deployment.
- The legacy system continues as fallback.
- Data migration for legacy attachments is part of Phase 4.

## Risks

- Concurrent draft edits from multiple devices.
- Attachment upload race condition between consume and message insert.
