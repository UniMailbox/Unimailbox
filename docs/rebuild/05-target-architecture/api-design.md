# API Design

See `../G-target-architecture.md §G.9` for the full route table. This document captures the rules.

## Base path

All routes are prefixed with `/api/v1`.

## HTTP methods

- `GET` — read.
- `POST` — create or perform action.
- `PATCH` — partial update.
- `DELETE` — delete.
- `PUT` — replace (only for `If-Match` optimistic concurrency on drafts).

## Path conventions

Resources are nouns; actions are sub-resources.

```text
POST /api/v1/mailboxes                      # create mailbox
GET  /api/v1/mailboxes                      # list mailboxes
GET  /api/v1/mailboxes/:id                  # read one mailbox
PATCH /api/v1/mailboxes/:id                 # rename mailbox
DELETE /api/v1/mailboxes/:id                # delete mailbox
GET  /api/v1/mailboxes/:id/members          # list members
POST /api/v1/mailboxes/:id/members          # add member
PATCH /api/v1/mailboxes/:id/members/:userId # change role
DELETE /api/v1/mailboxes/:id/members/:userId # remove member

POST /api/v1/messages/send                  # send a message (action)
GET  /api/v1/messages/:id                   # read one message
PATCH /api/v1/messages/:id/read             # mark read
PATCH /api/v1/messages/:id/star             # toggle star
DELETE /api/v1/messages/:id                 # delete
```

## Required headers

| Header | When | Purpose |
|---|---|---|
| `Authorization: Bearer <accessToken>` | All non-public routes | Authentication |
| `Idempotency-Key: <uuid>` | All mutating routes | Replay safety |
| `If-Match: <updatedAt>` | Draft update + draft send | Optimistic concurrency |
| `Accept-Language: en \| zh-CN` | Application requests | Client locale hint; errors are translated by code in the frontend |

## Response envelope

```json
{ "data": T }
```

or on error:

```json
{
  "error": {
    "code": "PROVIDER_SEND_FAILED",
    "message": "Email provider rejected the message",
    "requestId": "uuid-v4"
  }
}
```

`packages/contracts/src/errors.ts` is the closed machine-code catalog shared by
Worker and web. Worker `DomainError` uses this type; the frontend maps every
catalog entry to English and Simplified Chinese. Backend `message` is not UI
copy. Unknown codes and unrecognized responses show a localized generic error;
network and form-validation failures also use stable codes. Keep raw codes,
request IDs and API enum values unchanged when translating display text.

Own-account preferences use `GET/PATCH /api/v1/auth/me/preferences`. Own avatar
uses `GET/POST/DELETE /api/v1/auth/me/avatar`; POST is raw PNG/JPEG/WebP bytes,
at most 2 MiB. All writes require an Idempotency-Key. These endpoints require
authentication and completed password setup, without administrator permission.
See `../17-personal-settings-localization.md` for persistence and UI behavior.

## Status codes

| DomainError code | HTTP |
|---|---|
| Validation | 400 |
| Authn | 401 |
| Authz | 403 |
| Not found | 404 |
| State conflict / idempotency reused | 409 |
| Size limit | 413 |
| Rate limit | 429 |
| Provider failed | 502 |
| Lock contention | 503 |

## Pagination

Cursor-based:

```json
{
  "data": {
    "items": [...],
    "nextCursor": "opaque-signed-string-or-null"
  }
}
```

Cursor encodes `(created_at, id)` and is HMAC-signed.

## Webhooks

```
POST /api/v1/webhooks/:providerKey/:connectionId
```

- `connectionId` is opaque; selects the encrypted verification secret.
- Provider signature verification runs **before** JSON parse.
- Webhook responses: 200 on success/replay, 401 on bad signature, 503 on lock contention.

## Setup routes (gated until `installation_state.status='complete'`)

```
GET   /api/v1/setup/status
POST  /api/v1/setup/claim
POST  /api/v1/setup/preflight
POST  /api/v1/setup/administrator
POST  /api/v1/setup/cloudflare/dashboard-link
POST  /api/v1/setup/cloudflare/verify
POST  /api/v1/setup/domain
POST  /api/v1/setup/inbound-smoke-test
POST  /api/v1/setup/brevo
POST  /api/v1/setup/outbound-smoke-test
POST  /api/v1/setup/complete
```

Setup routes require a short-lived KV setup session after `/setup/claim`.

## Repair routes (gated behind authenticated admin)

Same path prefix `/api/v1/setup/*` but gated by:
1. Authentication (must be logged in).
2. `Role` of `administrator`.
3. `installation_state.installationVersion` indicates an upgrade is pending.

After repair step completes, repair session is destroyed.
