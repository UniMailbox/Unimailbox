# CAP-051 — Attachment download and local expiry cleanup

## Outcome

Implemented and independently verified on local `master`. The backend now serves consumed
attachments at `GET /api/v1/mailboxes/:mailboxId/attachments/:attachmentId/download` and reclaims
expired, unconsumed upload bytes from the existing `CACHE` KV namespace through the existing
scheduled entrypoint.

## Behavior

- Global `message.read` and mailbox-scoped `read` are both required.
- Missing, foreign, soft-deleted, unconsumed, and CACHE-missing attachments use one safe 404
  envelope; no attachment metadata or bytes are returned on failure.
- Successful downloads return exact binary bytes, canonical content type/length, and safe inline or
  attachment disposition headers.
- Expiry performs a guarded `uploaded → expired` D1 transition and correlated
  `attachment.expired` audit write before CACHE deletion. A failed delete leaves the expired row
  retryable; a failed D1 transition preserves the uploaded row and bytes. Concurrent cleanup and
  consume paths are race-safe.

## Verification

| Check | Result |
|---|---:|
| Migration reset/verify | 22/22 |
| CAP-051 focused Worker tests | 9/9 |
| Full Worker tests | 866/866 |
| Unit tests | 975/975 |
| Contracts tests | 369/369 |
| Scaffold doctor | 14/14 |
| Lint/typecheck/format/build/diff check | pass |

The test runner reported that it loads `apps/worker/.dev.vars`; no values were inspected, printed,
copied, or changed. No push, deploy, R2 change, new KV namespace, or production operation was
performed.

## Deferred

Client CID/render work, durable R2 retention, and preview verification remain separate follow-up
work. The single existing `CACHE` namespace and CAP-049 temporary 5 MiB/one-hour policy remain in
force.
