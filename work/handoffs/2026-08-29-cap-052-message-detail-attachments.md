# CAP-052 — Message detail attachment projection

## Outcome

Implemented and independently reviewed on local `master`. The existing message-detail endpoint now
returns a metadata-only `attachments` array for consumed attachment relations.

## Behavior

- The Messages read boundary selects only consumed `message_attachments` for the authorized message.
- Descriptors contain exactly `id`, `filename`, `contentType`, `sizeBytes`, `disposition`, and
  nullable `contentId`, ordered by `created_at ASC, id ASC`.
- Upload IDs, storage keys, bytes, credentials, and idempotency material are not returned or logged.
- Existing global `message.read`, mailbox-scoped authorization, cross-mailbox 404, and per-user
  soft-delete behavior remain unchanged.
- The Worker always emits an array; the shared schema keeps the field optional for legacy client
  rollout.

## Verification

| Check | Result |
|---|---:|
| Migration reset/verify | 22/22 |
| CAP-052 focused Worker tests | 4/4 |
| Existing message Worker regression | 63/63 |
| Full Worker tests | 870/870 |
| Unit tests | 977/977 |
| Contracts tests | 371/371 |
| Scaffold doctor | 14/14 |
| Lint/typecheck/format/build/diff check | pass |
| Grok architecture/security review | ACCEPT |

The test runner reported loading `apps/worker/.dev.vars`; no values were inspected, printed,
copied, or changed. No push, deploy, R2 change, extra KV namespace, or production operation was
performed.

## Deferred

Client download/render controls and inline CID rewriting are the next local slice. Durable R2
retention and preview/provider verification remain separately deferred.
