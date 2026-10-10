# CAP-021 — Inbound mail: MIME parse → Message + MailboxMessage in one D1 batch

**Phase:** 1 · **Status:** In Progress

## Goal

When an email arrives at the Worker's `email` handler, parse the MIME, extract metadata, find the target mailbox by recipient address, and persist the message + mailbox association in one atomic D1 batch (R-INBOUND-008).

## Scope

- **Migration** `0006_messages.sql` — messages, message_recipients, mailbox_messages, message_user_state tables.
- **Messages module** (`modules/messages/`): message repository (create message + recipients + mailbox association in one batch).
- **Email handler update** (`entrypoints/inbound-email.ts`): replace the CAP-013 smoke-test-only handler with real inbound processing. Parse MIME via email-core, find mailbox, persist.
- **email-core** (`packages/email-core/src/index.ts`): MIME parsing function — extract from, to, subject, html, text, messageId, inReplyTo from raw email.
- **Tests**: inbound email → message persisted, mailbox association correct.

## Migration

```sql
CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT,
  from_address        TEXT NOT NULL,
  from_name           TEXT NOT NULL DEFAULT '',
  subject             TEXT NOT NULL DEFAULT '',
  html_body           TEXT NOT NULL DEFAULT '',
  text_body           TEXT NOT NULL DEFAULT '',
  message_id_header   TEXT,
  in_reply_to_header  TEXT,
  references_header   TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL CHECK (status IN ('draft','queued','sending','sent','delivered','delayed','bounced','complained','failed')) DEFAULT 'delivered',
  error_code          TEXT,
  error_message       TEXT,
  raw_object_key      TEXT,
  created_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  received_at         TEXT,
  sent_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_recipients (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL CHECK (type IN ('to', 'cc', 'bcc')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS message_recipients_message_idx ON message_recipients(message_id);

CREATE TABLE IF NOT EXISTS mailbox_messages (
  id            TEXT PRIMARY KEY,
  mailbox_id    TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  is_read       INTEGER NOT NULL DEFAULT 0,
  is_starred    INTEGER NOT NULL DEFAULT 0,
  folder        TEXT NOT NULL DEFAULT 'inbox',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mailbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS mailbox_messages_mailbox_idx ON mailbox_messages(mailbox_id);

CREATE TABLE IF NOT EXISTS message_user_state (
  mailbox_message_id TEXT PRIMARY KEY REFERENCES mailbox_messages(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read            INTEGER NOT NULL DEFAULT 0,
  read_at            TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0006_messages.sql');
```

## Email handler flow

```
Email arrives → parse MIME → extract from/to/subject/bodies
→ for each recipient address, find mailbox by address
→ if mailbox found: create message + recipients + mailbox_messages in one D1 batch
→ if no mailbox found: reject (unknown recipient policy)
```

## email-core MIME parsing

Keep it minimal for Phase 1. The raw email is a `ForwardableEmailMessage` with `message.raw` (ReadableStream). Read the stream, parse basic headers + body split.

```typescript
export interface ParsedEmail {
  from: { address: string; name: string };
  to: Array<{ address: string; name: string }>;
  cc: Array<{ address: string; name: string }>;
  subject: string;
  htmlBody: string;
  textBody: string;
  messageId: string | null;
  inReplyTo: string | null;
}

export async function parseEmail(rawEmail: string): Promise<ParsedEmail>
```

Parse RFC 5322 headers manually (headers before first blank line, body after). Extract From, To, Cc, Subject, Message-ID, In-Reply-To. Split multipart for HTML/text if present (basic — don't overengineer MIME for Phase 1).

## Files

| Agent | Owns |
|---|---|
| implementer | `migrations/0006_messages.sql` + verify |
| implementer | `apps/worker/src/database/schema/messages.ts` (new) |
| implementer | `apps/worker/src/database/schema/index.ts` |
| implementer | `apps/worker/src/database/schema-version.ts` (→ '0006') |
| implementer | `packages/email-core/src/index.ts` (parseEmail) |
| implementer | `packages/email-core/src/index.test.ts` |
| implementer | `apps/worker/src/modules/messages/index.ts` (new) |
| implementer | `apps/worker/src/modules/messages/message-repository.ts` (new) |
| implementer | `apps/worker/src/entrypoints/inbound-email.ts` (update — real inbound) |
| implementer | `packages/contracts/src/index.ts` (message types if needed) |
| implementer | `packages/test-kit/src/migrationsDb.ts` (add 0006) |
| implementer | `apps/worker/src/entrypoints/inbound-email.worker.test.ts` (update) |

## Acceptance criteria

- [ ] Email to a known mailbox → message + recipients + mailbox_messages persisted in one D1 batch
- [ ] Email to unknown recipient → rejected
- [ ] Parsed email has correct from, to, subject
- [ ] Message status = 'delivered' for inbound
- [ ] Multiple recipients → multiple mailbox_messages rows (one per matched mailbox)
- [ ] Smoke test messages still accepted (backward compatible)
- [ ] Quality gates pass

## Quality gates

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:worker && pnpm build && pnpm scaffold doctor
```
