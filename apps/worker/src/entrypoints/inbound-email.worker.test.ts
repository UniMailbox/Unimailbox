/**
 * Worker-pool test for inbound-email handler — CAP-021.
 * Tests real inbound mail processing: MIME parse → message persisted → mailbox associations.
 *
 * D-CAP-021 / CAP-035: also covers R-INBOUND-005 (blocklist) and
 * R-INBOUND-006 (per-role banEmail) rejection paths. Rejection
 * short-circuits before any DB write (Decision §Q4: audit OUT OF SCOPE).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import inboundEmail from './inbound-email';
import { migrationsDb, seedInstallationState } from '@unimailbox/test-kit';
import { systemIds } from '../platform/ids';
import { prepareCreateDomain } from '../modules/tenancy';
import { hashPassword } from '../platform/crypto';

// Module-scope helpers — used by both describe blocks (CAP-021 base
// behaviour + D-CAP-021 / CAP-035 rejection paths).
async function createTestUser(db: D1Database): Promise<string> {
  const userId = systemIds.uuid();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      userId,
      'test@example.com',
      'Test User',
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    )
    .run();

  return userId;
}

async function createTestDomain(db: D1Database): Promise<string> {
  const domainId = systemIds.uuid();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const domainStmt = prepareCreateDomain(db, {
    id: domainId,
    name: 'example.com',
    status: 'active',
    outboundConnectionId: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.batch([domainStmt]);
  return domainId;
}

async function createTestMailbox(
  db: D1Database,
  domainId: string,
  ownerUserId: string,
  localPart: string,
): Promise<string> {
  const mailboxId = systemIds.uuid();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db
    .prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(mailboxId, domainId, ownerUserId, localPart, `${localPart} Mailbox`, 'active', now, now)
    .run();
  return mailboxId;
}

function makeMessage(
  to: string,
  from: string,
  subject: string,
  raw: string,
): ForwardableEmailMessage {
  let rejectReason: string | null = null;
  return {
    to,
    from,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    }),
    rawSize: raw.length,
    setReject: async (reason: string): Promise<void> => {
      rejectReason = reason;
    },
    forward: async (_rcptTo: string, _headers?: Headers): Promise<void> => {},
    reply: async (_message: unknown): Promise<void> => {},
    // Test-only accessor for verifying rejection behavior
    ...{ _getRejectReason: (): string | null => rejectReason },
  } as unknown as ForwardableEmailMessage & { _getRejectReason(): string | null };
}

describe('inbound-email handler — CAP-021', () => {
  beforeEach(async () => {
    const db = await migrationsDb();

    // Clean up any existing data
    await db.prepare('DELETE FROM blocklist_entries').run();
    await db.prepare('DELETE FROM role_policies').run();
    await db.prepare('DELETE FROM user_roles').run();
    await db.prepare('DELETE FROM mailbox_messages').run();
    await db.prepare('DELETE FROM message_recipients').run();
    await db.prepare('DELETE FROM messages').run();
    await db.prepare('DELETE FROM mailboxes').run();
    await db.prepare('DELETE FROM managed_domains').run();
    await db.prepare('DELETE FROM users').run();
  });

  it('parses and persists an inbound email to a known mailbox', async () => {
    const db = await migrationsDb();

    // Setup: create a user, domain, and mailbox
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    const mailboxId = await createTestMailbox(db, domainId, userId, 'inbox');

    // Create a raw RFC 5322 email
    const rawEmail = `From: sender@example.com
To: inbox@example.com
Subject: Test inbound email
Message-ID: <test@message.id>

This is a test email body.`;

    const message = makeMessage(
      'inbox@example.com',
      'sender@example.com',
      'Test inbound email',
      rawEmail,
    );

    // Process the email
    await inboundEmail.email(message, env);

    // Verify no rejection (mailbox was found)
    expect(message._getRejectReason()).toBeNull();

    // Verify message was persisted
    const messages = await db
      .prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 1')
      .first();
    expect(messages).toBeDefined();
    expect(messages?.from_address).toBe('sender@example.com');
    expect(messages?.subject).toBe('Test inbound email');
    expect(messages?.text_body).toBe('This is a test email body.');
    expect(messages?.status).toBe('delivered'); // Inbound emails have status 'delivered'
    expect(messages?.message_id_header).toBe('<test@message.id>');

    // Verify recipients were persisted
    const recipients = await db
      .prepare('SELECT * FROM message_recipients WHERE message_id = ?')
      .bind(messages?.id)
      .all();
    expect(recipients.results).toHaveLength(1);
    expect(recipients.results?.[0].address).toBe('inbox@example.com');
    expect(recipients.results?.[0].type).toBe('to');

    // Verify mailbox_messages was persisted
    const mailboxMessages = await db
      .prepare('SELECT * FROM mailbox_messages WHERE message_id = ?')
      .bind(messages?.id)
      .all();
    expect(mailboxMessages.results).toHaveLength(1);
    expect(mailboxMessages.results?.[0].mailbox_id).toBe(mailboxId);
    expect(mailboxMessages.results?.[0].folder).toBe('inbox');
    expect(mailboxMessages.results?.[0].is_read).toBe(0); // INTEGER stored as number
    expect(mailboxMessages.results?.[0].is_starred).toBe(0);
  });

  it('rejects email to unknown recipient', async () => {
    await migrationsDb();

    // No domain or mailbox setup

    const rawEmail = `From: sender@example.com
To: unknown@example.com
Subject: Test

Body`;

    const message = makeMessage('unknown@example.com', 'sender@example.com', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    // Verify rejection
    expect(message._getRejectReason()).toBe(
      'Unknown recipient. No mailbox found for this address.',
    );
  });

  it('handles multiple recipients with some known and some unknown', async () => {
    const db = await migrationsDb();

    // Setup: create a user, domain, and one mailbox
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    const mailboxId = await createTestMailbox(db, domainId, userId, 'inbox');

    // Email to known and unknown recipients
    const rawEmail = `From: sender@example.com
To: inbox@example.com, unknown@example.com
Cc: another-unknown@example.com
Subject: Test

Body`;

    const message = makeMessage('inbox@example.com', 'sender@example.com', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    // Should accept because at least one recipient has a mailbox
    expect(message._getRejectReason()).toBeNull();

    // Verify message was created
    const messages = await db.prepare('SELECT * FROM messages LIMIT 1').first();
    expect(messages).toBeDefined();

    // Verify only one mailbox_message (for the known mailbox)
    const mailboxMessages = await db
      .prepare('SELECT * FROM mailbox_messages WHERE message_id = ?')
      .bind(messages?.id)
      .all();
    expect(mailboxMessages.results).toHaveLength(1);
    expect(mailboxMessages.results?.[0].mailbox_id).toBe(mailboxId);

    // Verify all recipients were stored
    const recipients = await db
      .prepare('SELECT * FROM message_recipients WHERE message_id = ?')
      .bind(messages?.id)
      .all();
    expect(recipients.results).toHaveLength(3); // 1 to + 1 cc
  });

  it('handles multiple mailboxes for different recipients', async () => {
    const db = await migrationsDb();

    // Setup: create a user, domain, and two mailboxes
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    const mailboxId1 = await createTestMailbox(db, domainId, userId, 'inbox');
    const mailboxId2 = await createTestMailbox(db, domainId, userId, 'support');

    // Email to two mailboxes
    const rawEmail = `From: sender@example.com
To: inbox@example.com, support@example.com
Subject: Test

Body`;

    const message = makeMessage('inbox@example.com', 'sender@example.com', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toBeNull();

    // Verify message was created
    const messages = await db.prepare('SELECT * FROM messages LIMIT 1').first();
    expect(messages).toBeDefined();

    // Verify two mailbox_messages rows
    const mailboxMessages = await db
      .prepare('SELECT * FROM mailbox_messages WHERE message_id = ? ORDER BY mailbox_id')
      .bind(messages?.id)
      .all();
    expect(mailboxMessages.results).toHaveLength(2);
    const mailboxIds = mailboxMessages.results?.map((m) => m.mailbox_id).sort();
    expect(mailboxIds).toEqual([mailboxId1, mailboxId2].sort());
  });

  it('parses multipart/alternative emails', async () => {
    const db = await migrationsDb();

    // Setup
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    await createTestMailbox(db, domainId, userId, 'inbox');

    // Multipart email
    const rawEmail = `From: sender@example.com
To: inbox@example.com
Subject: Multipart test
Content-Type: multipart/alternative; boundary=boundary123

--boundary123
Content-Type: text/plain

Plain text body
--boundary123
Content-Type: text/html

<html><body>HTML body</body></html>
--boundary123--`;

    const message = makeMessage(
      'inbox@example.com',
      'sender@example.com',
      'Multipart test',
      rawEmail,
    );

    await inboundEmail.email(message, env);

    const messages = await db.prepare('SELECT * FROM messages LIMIT 1').first();
    expect(messages?.text_body).toBe('Plain text body');
    expect(messages?.html_body).toBe('<html><body>HTML body</body></html>');
  });

  it('preserves email headers like In-Reply-To and References', async () => {
    const db = await migrationsDb();

    // Setup
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    await createTestMailbox(db, domainId, userId, 'inbox');

    // Reply email
    const rawEmail = `From: sender@example.com
To: inbox@example.com
Subject: Re: Thread
Message-ID: <reply@message.id>
In-Reply-To: <original@message.id>
References: <original@message.id> <another@message.id>

Reply body`;

    const message = makeMessage('inbox@example.com', 'sender@example.com', 'Re: Thread', rawEmail);

    await inboundEmail.email(message, env);

    const messages = await db.prepare('SELECT * FROM messages LIMIT 1').first();
    expect(messages?.message_id_header).toBe('<reply@message.id>');
    expect(messages?.in_reply_to_header).toBe('<original@message.id>');
    expect(messages?.references_header).toBe('<original@message.id> <another@message.id>');
  });

  it('lowercases addresses per R-DATA-001', async () => {
    const db = await migrationsDb();

    // Setup
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    await createTestMailbox(db, domainId, userId, 'inbox');

    // Email with uppercase address
    const rawEmail = `From: Sender@EXAMPLE.COM
To: Inbox@Example.COM
Subject: Test

Body`;

    const message = makeMessage('Inbox@Example.COM', 'Sender@EXAMPLE.COM', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    const messages = await db.prepare('SELECT * FROM messages LIMIT 1').first();
    expect(messages?.from_address).toBe('sender@example.com'); // lowercased

    const recipients = await db
      .prepare('SELECT * FROM message_recipients WHERE message_id = ?')
      .bind(messages?.id)
      .all();
    expect(recipients.results?.[0].address).toBe('inbox@example.com'); // lowercased
  });
});

// ---------------------------------------------------------------------------
// D-CAP-021 / CAP-035 — R-INBOUND-005 + R-INBOUND-006 rejection paths.
//
// Rejection short-circuits BEFORE any DB write (no messages row, no audit).
// ---------------------------------------------------------------------------

describe('inbound-email handler — D-CAP-021 / CAP-035', () => {
  beforeEach(async () => {
    const db = await migrationsDb();
    await db.prepare('DELETE FROM installation_state').run();
    await db.prepare('DELETE FROM blocklist_entries').run();
    await db.prepare('DELETE FROM role_policies').run();
    await db.prepare('DELETE FROM user_roles').run();
    await db.prepare('DELETE FROM mailbox_messages').run();
    await db.prepare('DELETE FROM message_recipients').run();
    await db.prepare('DELETE FROM messages').run();
    await db.prepare('DELETE FROM mailboxes').run();
    await db.prepare('DELETE FROM managed_domains').run();
    await db.prepare('DELETE FROM users').run();
    await db.prepare("DELETE FROM roles WHERE id NOT IN ('administrator', 'member')").run();
    await db.prepare('DELETE FROM audit_events').run();
  });

  async function setupMailboxWithRolePolicy(
    policyJson: { ban_email_patterns_json: string; avail_domain_patterns_json: string } | null,
  ): Promise<{ userId: string; mailboxId: string }> {
    const db = await migrationsDb();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });

    // Custom role for the mailbox owner (so we can attach a policy).
    await db
      .prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('test-owner', 'test-owner', 'Test owner', 1, datetime('now'))`,
      )
      .run();

    const userId = await createTestUser(db);
    await db
      .prepare(
        `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'test-owner', datetime('now'))`,
      )
      .bind(userId)
      .run();

    const domainId = await createTestDomain(db);
    const mailboxId = await createTestMailbox(db, domainId, userId, 'inbox');

    if (policyJson) {
      await db
        .prepare(
          `INSERT INTO role_policies (role_id, ban_email_patterns_json, avail_domain_patterns_json, updated_by, updated_at)
         VALUES ('test-owner', ?, ?, ?, datetime('now'))`,
        )
        .bind(policyJson.ban_email_patterns_json, policyJson.avail_domain_patterns_json, userId)
        .run();
    }

    return { userId, mailboxId };
  }

  // R-INBOUND-005 — blocklist hits subject, denies before any DB write.
  it('rejects when subject matches a blocklist entry (R-INBOUND-005)', async () => {
    const db = await migrationsDb();
    const { mailboxId: _mailboxId } = await setupMailboxWithRolePolicy(null);

    // Insert a blocklist entry matching the subject.
    await db
      .prepare(
        `INSERT INTO blocklist_entries (id, kind, pattern, created_by, created_at)
       VALUES ('blocklist-subj', 'subject', 'special offer', NULL, datetime('now'))`,
      )
      .run();

    const rawEmail = `From: sender@example.com
To: inbox@example.com
Subject: SPECIAL OFFER today
Message-ID: <block-test-1@message.id>

Body`;

    const message = makeMessage(
      'inbox@example.com',
      'sender@example.com',
      'SPECIAL OFFER today',
      rawEmail,
    );

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toMatch(/special offer/i);
    expect(message._getRejectReason()).toContain('subject');

    // No message persisted (R-INBOUND-008: rejection short-circuits).
    const msg = await db
      .prepare('SELECT id FROM messages WHERE message_id_header = ?')
      .bind('<block-test-1@message.id>')
      .first();
    expect(msg).toBeNull();

    // No audit row written (Decision §Q4: audit on reject OUT OF SCOPE).
    const audit = await db
      .prepare("SELECT id FROM audit_events WHERE resource_type = 'message'")
      .first();
    expect(audit).toBeNull();
  });

  // R-INBOUND-006 — banEmail exact match denies.
  it('rejects when sender matches a banEmail exact pattern (R-INBOUND-006)', async () => {
    const db = await migrationsDb();
    const { mailboxId: _mailboxId } = await setupMailboxWithRolePolicy({
      ban_email_patterns_json: JSON.stringify(['spammer@example.com']),
      avail_domain_patterns_json: '[]',
    });

    const rawEmail = `From: spammer@example.com
To: inbox@example.com
Subject: Hello
Message-ID: <block-test-2@message.id>

Body`;

    const message = makeMessage('inbox@example.com', 'spammer@example.com', 'Hello', rawEmail);

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toContain('banned');
    expect(message._getRejectReason()).toContain('spammer@example.com');

    const msg = await db
      .prepare('SELECT id FROM messages WHERE message_id_header = ?')
      .bind('<block-test-2@message.id>')
      .first();
    expect(msg).toBeNull();
  });

  // R-INBOUND-006 — banEmail `*` denies even if domain would be allowed.
  it('rejects when banEmail is a wildcard * (R-INBOUND-006 — ban precedence)', async () => {
    const db = await migrationsDb();
    const { mailboxId: _mailboxId } = await setupMailboxWithRolePolicy({
      ban_email_patterns_json: JSON.stringify(['*']),
      avail_domain_patterns_json: JSON.stringify(['@example.com']),
    });

    const rawEmail = `From: anyone@example.com
To: inbox@example.com
Subject: Hello
Message-ID: <block-test-3@message.id>

Body`;

    const message = makeMessage('inbox@example.com', 'anyone@example.com', 'Hello', rawEmail);

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toContain('banned');

    const msg = await db
      .prepare('SELECT id FROM messages WHERE message_id_header = ?')
      .bind('<block-test-3@message.id>')
      .first();
    expect(msg).toBeNull();
  });
});
