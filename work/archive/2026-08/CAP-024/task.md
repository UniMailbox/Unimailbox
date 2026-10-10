# CAP-024 — Brevo webhook → message delivered; signature verified before JSON parse

**Phase:** 1 · **Status:** In Progress

## Goal

Brevo sends delivery event webhooks. The system receives them at `POST /api/v1/webhooks/:providerKey/:connectionId`, verifies the HMAC-SHA256 signature of the raw body **before parsing JSON**, then updates the message status to `delivered` and stores the webhook delivery record.

## Scope

- **Migration** `0008_webhook_events.sql` — `webhook_deliveries` table + `webhook_secret` column on `provider_connections`.
- **Webhook route** (`http/routes/webhooks.ts`): `POST /api/v1/webhooks/:providerKey/:connectionId`.
- **Webhook processing** (`modules/outbound-mail/webhook-processor.ts`): verify → parse → update message → store delivery record.
- **Webhook delivery repository** (`modules/outbound-mail/webhook-repository.ts`): store delivery records.
- **Admin endpoint** (`http/routes/admin.ts` modify or new): `GET /api/v1/admin/connections` — returns webhook URL + secret for operator configuration.
- **Contracts** — webhook event schema.
- **Schema + test-kit updates**: webhook_deliveries schema, schema version bump, migrationsDb.

## Security requirement

**Signature verification runs before JSON parse** (.claude/rules/architecture.md §API conventions, .claude/rules/security.md §Secrets):

1. Read raw body: `const rawBody = await c.req.text();`
2. Get signature from `X-Webhook-Signature` header
3. Get webhook_secret from provider_connections (decrypt if encrypted, or plain column)
4. Compute: `await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])` then `await crypto.subtle.sign('HMAC', key, encode(rawBody))`
5. Compare hex digests using `constantTimeCompare` from `platform/crypto.ts`
6. Only if verified → `JSON.parse(rawBody)` → process event
7. If not verified → 401 `WEBHOOK_SIGNATURE_INVALID`

## Webhook event flow

```
POST /api/v1/webhooks/:providerKey/:connectionId
  body = raw (Brevo event JSON)
  header X-Webhook-Signature = HMAC-SHA256(rawBody, webhookSecret)

→ read rawBody (before JSON parse)
→ look up provider_connection by connectionId
→ get-or-generate webhook_secret (stored on the connection row)
→ verify HMAC-SHA256(rawBody, secret) === header (constant-time compare)
→ if invalid: 401
→ parse JSON
→ extract: event type, message_id (Brevo's), delivery status
→ find message by provider_message_id (stored in outbound_jobs.provider_message_id)
→ update message status to 'delivered' (or 'bounced'/'complained' per event)
→ INSERT webhook_deliveries row
→ return 200
```

## Migration

```sql
-- Add webhook_secret to provider_connections
ALTER TABLE provider_connections ADD COLUMN webhook_secret TEXT;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY,
  connection_id   TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,
  message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'processed',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_connection_idx ON webhook_deliveries(connection_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries(created_at DESC);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0008_webhook_events.sql');
```

## Files

| Agent | Owns |
|---|---|
| implementer | `migrations/0008_webhook_events.sql` + verify |
| implementer | `apps/worker/src/database/schema/outbound-mail.ts` (add webhookDeliveries + webhook_secret col) |
| implementer | `apps/worker/src/database/schema-version.ts` (→ '0008') |
| implementer | `apps/worker/src/modules/outbound-mail/webhook-repository.ts` (new) |
| implementer | `apps/worker/src/modules/outbound-mail/webhook-processor.ts` (new — verify + process) |
| implementer | `apps/worker/src/modules/outbound-mail/index.ts` (add exports) |
| implementer | `apps/worker/src/http/routes/webhooks.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` (mount webhook routes) |
| implementer | `packages/contracts/src/index.ts` (webhook event types) |
| implementer | `packages/test-kit/src/migrationsDb.ts` (add 0008) |
| implementer | `apps/worker/src/http/routes/preflight.worker.test.ts` (schema version → '0008') |
| implementer | `apps/worker/src/http/routes/webhooks.worker.test.ts` (new) |

## Acceptance criteria

- [ ] POST webhook with valid signature → 200, message status updated to 'delivered'
- [ ] POST webhook with invalid signature → 401 WEBHOOK_SIGNATURE_INVALID (before JSON parse)
- [ ] POST webhook with missing signature header → 401
- [ ] Unknown connectionId → 404
- [ ] webhook_deliveries row stored for each processed event
- [ ] Quality gates pass

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
