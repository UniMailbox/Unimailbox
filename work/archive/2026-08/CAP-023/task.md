# CAP-023 — Compose reply + send → outbound job → queue consumer → Brevo

**Phase:** 1 · **Status:** In Progress

## Goal

An authenticated user can compose a reply (or new message) from a mailbox they have `send` permission on. The message is persisted with status `queued`, an outbound job is created, and the queue consumer sends it via the Brevo adapter and updates the status to `sent`.

## Scope

- **Migration** `0007_outbound_jobs.sql` — outbound_jobs table.
- **Outbound job repository** (`modules/outbound-mail/job-repository.ts`): create, getById, updateStatus.
- **Compose route** (`http/routes/compose.ts`): `POST /api/v1/mailboxes/:mailboxId/messages/send`.
- **Queue consumer** (`entrypoints/queue.ts`): real processing — read job, decrypt credential, send via Brevo, update message status.
- **Process outbound job use case** (`modules/outbound-mail/process-outbound-job.ts`): the logic, testable without queue plumbing.
- **Contracts** (`packages/contracts/src/index.ts`): compose request schema.
- **Schema + test-kit updates**: outbound_jobs Drizzle schema, schema version bump, migrationsDb.

## Migration

```sql
CREATE TABLE IF NOT EXISTS outbound_jobs (
  id                    TEXT PRIMARY KEY,
  message_id            TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  status                TEXT NOT NULL CHECK (status IN ('queued','sending','sent','delayed','bounced','complained','failed')) DEFAULT 'queued',
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 3,
  locked_at             TEXT,
  locked_by             TEXT,
  provider_message_id   TEXT,
  error_code            TEXT,
  error_message         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS outbound_jobs_status_idx ON outbound_jobs(status);
CREATE INDEX IF NOT EXISTS outbound_jobs_message_idx ON outbound_jobs(message_id);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0007_outbound_jobs.sql');
```

## Compose endpoint flow

```
POST /api/v1/mailboxes/:mailboxId/messages/send
→ requirePermission('message.send')
→ assertCan(db, userId, mailboxId, 'send', isAdmin)
→ validate body (to, cc, subject, htmlBody, textBody, inReplyTo?, references?)
→ get mailbox address (mailbox.local_part @ domain.name)
→ get active provider_connection
→ D1 batch:
    INSERT messages (status='queued', from_address=mailbox address, created_by_user_id=userId, ...)
    INSERT message_recipients (to + cc)
    INSERT mailbox_messages (folder='sent')
    INSERT outbound_jobs (status='queued', provider_connection_id=connection.id)
→ enqueue OUTBOUND queue with jobId
→ return 202 { data: { messageId, status: 'queued' } }
```

R-OUTBOUND-006: send + outbound_jobs + idempotency in one D1 batch (idempotency deferred to CAP-027).

## Queue consumer flow

```
For each message in batch:
→ parse body as { jobId }
→ call processOutboundJob(db, jobId, encryptionKey)
  → read job + message + provider_connection from DB
  → decrypt API key from encrypted_credentials
  → build SendProviderMessage from message data
  → update job status to 'sending'
  → call adapter.send(ctx, msg)
  → update message status to 'sent' + sent_at + provider_message_id
  → update job status to 'sent' + provider_message_id
  → on failure: update job status to 'failed', increment attempts, ack/retry
```

## Files

| Agent | Owns |
|---|---|
| implementer | `migrations/0007_outbound_jobs.sql` + verify |
| implementer | `apps/worker/src/database/schema/outbound-mail.ts` (add outboundJobs) |
| implementer | `apps/worker/src/database/schema-version.ts` (→ '0007') |
| implementer | `apps/worker/src/modules/outbound-mail/job-repository.ts` (new) |
| implementer | `apps/worker/src/modules/outbound-mail/process-outbound-job.ts` (new) |
| implementer | `apps/worker/src/modules/outbound-mail/index.ts` (add exports) |
| implementer | `apps/worker/src/http/routes/compose.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` (mount compose routes) |
| implementer | `apps/worker/src/entrypoints/queue.ts` (real consumer) |
| implementer | `packages/contracts/src/index.ts` (compose request schema) |
| implementer | `packages/contracts/src/index.test.ts` (schema test) |
| implementer | `packages/test-kit/src/migrationsDb.ts` (add 0007) |
| implementer | `apps/worker/src/http/routes/compose.worker.test.ts` (new) |
| implementer | `apps/worker/src/entrypoints/queue.worker.test.ts` (new) |
| implementer | `apps/worker/src/http/routes/preflight.worker.test.ts` (schema version → '0007') |

## Acceptance criteria

- [ ] POST compose creates message (status=queued) + recipients + mailbox_message + outbound_job in one D1 batch
- [ ] Queue consumer sends via Brevo and updates message status to 'sent'
- [ ] Queue consumer handles failure: marks job 'failed', increments attempts
- [ ] assertCan(userId, mailboxId, 'send') blocks viewers from sending
- [ ] IDOR: user cannot send from another user's mailbox
- [ ] Response includes messageId and status
- [ ] Quality gates pass

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
