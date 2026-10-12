/**
 * Worker-pool test for inbound-email handler — CAP-021.
 * Tests real inbound mail processing: MIME parse → message persisted → mailbox associations.
 *
 * D-CAP-021 / CAP-035: also covers R-INBOUND-005 (blocklist) and
 * R-INBOUND-006 (per-role banEmail) rejection paths. Rejection
 * short-circuits before any DB write (Decision §Q4: audit OUT OF SCOPE).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import inboundEmail from './inbound-email';
import { migrationsDb, seedInstallationState } from '@unimailbox/test-kit';
import { systemIds } from '../platform/ids';
import { prepareCreateDomain } from '../modules/tenancy';
import { hashPassword } from '../platform/crypto';
import { downloadAttachment } from '../modules/attachments';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../platform/cache';

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

  it('stores an unknown envelope in the same-domain catch-all and preserves an external copy', async () => {
    const db = await migrationsDb();
    const owner = await createTestUser(db);
    const domain = await createTestDomain(db);
    const mailbox = await createTestMailbox(db, domain, owner, 'admin');
    const message = makeMessage(
      'ANYTHING@EXAMPLE.COM',
      'sender@example.net',
      'Catch-all',
      'From: sender@example.net\r\nTo: someone@example.net\r\nSubject: Catch-all\r\n\r\nBody',
    );
    const forward = vi.fn(async () => {});
    message.forward = forward;
    await inboundEmail.email(message, {
      ...env,
      INBOUND_CATCH_ALL_MAILBOX: 'ADMIN@example.com',
      INBOUND_FORWARD_TO: 'copy@example.net',
    });
    expect(message._getRejectReason()).toBeNull();
    expect(forward).toHaveBeenCalledExactlyOnceWith('copy@example.net');
    const stored = await db.prepare('SELECT mailbox_id FROM mailbox_messages').first();
    expect(stored?.mailbox_id).toBe(mailbox);
    expect(
      await db.prepare("SELECT address FROM message_recipients WHERE type = 'bcc'").first(),
    ).toMatchObject({ address: 'anything@example.com' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mailboxes').first()).toMatchObject({
      count: 1,
    });
  });

  it.each(['active', 'disabled', 'deleted'])(
    'gives an explicit %s mailbox priority over catch-all',
    async (status) => {
      const db = await migrationsDb();
      const owner = await createTestUser(db);
      const domain = await createTestDomain(db);
      await createTestMailbox(db, domain, owner, 'admin');
      const exact = await createTestMailbox(db, domain, owner, 'hello');
      await db.prepare('UPDATE mailboxes SET status = ? WHERE id = ?').bind(status, exact).run();
      const message = makeMessage(
        'hello@example.com',
        'sender@example.net',
        'Exact',
        'From: sender@example.net\r\nTo: hello@example.com\r\n\r\nBody',
      );
      await inboundEmail.email(message, { ...env, INBOUND_CATCH_ALL_MAILBOX: 'admin@example.com' });
      const stored = await db.prepare('SELECT mailbox_id FROM mailbox_messages').first();
      if (status === 'active') expect(stored?.mailbox_id).toBe(exact);
      else {
        expect(message._getRejectReason()).toContain('Unknown recipient');
        expect(stored).toBeNull();
      }
    },
  );

  it('never forwards or falls back across domains', async () => {
    const db = await migrationsDb();
    const owner = await createTestUser(db);
    const domain = await createTestDomain(db);
    await createTestMailbox(db, domain, owner, 'admin');
    const message = makeMessage(
      'unknown@other.example',
      'sender@example.net',
      'Other',
      'From: sender@example.net\r\nTo: admin@example.com\r\n\r\nBody',
    );
    const forward = vi.fn(async () => {});
    message.forward = forward;
    await inboundEmail.email(message, {
      ...env,
      INBOUND_CATCH_ALL_MAILBOX: 'admin@example.com',
      INBOUND_FORWARD_TO: 'copy@example.net',
    });
    expect(forward).not.toHaveBeenCalled();
    expect(message._getRejectReason()).toContain('Unknown recipient');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM messages').first()).toMatchObject({
      count: 0,
    });
  });

  it('rejects a disabled catch-all without automatically creating a mailbox', async () => {
    const db = await migrationsDb();
    const owner = await createTestUser(db);
    const domain = await createTestDomain(db);
    const mailbox = await createTestMailbox(db, domain, owner, 'admin');
    await db.prepare("UPDATE mailboxes SET status = 'disabled' WHERE id = ?").bind(mailbox).run();
    const message = makeMessage(
      'unknown@example.com',
      'sender@example.net',
      'Disabled',
      'From: sender@example.net\r\nTo: unknown@example.com\r\n\r\nBody',
    );
    await inboundEmail.email(message, { ...env, INBOUND_CATCH_ALL_MAILBOX: 'admin@example.com' });
    expect(message._getRejectReason()).toContain('Unknown recipient');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM mailboxes').first()).toMatchObject({
      count: 1,
    });
  });

  it('surfaces a forwarding failure before writing any mail or R2 objects', async () => {
    const db = await migrationsDb();
    const before = (await env.ATTACHMENTS.list()).objects.length;
    const message = makeMessage('hello@example.com', 'sender@example.net', 'Failure', 'Body');
    message.forward = vi.fn(async () => {
      throw new Error('Forward failed');
    });
    await expect(
      inboundEmail.email(message, {
        ...env,
        INBOUND_CATCH_ALL_MAILBOX: 'admin@example.com',
        INBOUND_FORWARD_TO: 'copy@example.net',
      }),
    ).rejects.toThrow('Forward failed');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM messages').first()).toMatchObject({
      count: 0,
    });
    expect((await env.ATTACHMENTS.list()).objects).toHaveLength(before);
  });

  it.each(['invalid', 'loop@example.com'])(
    'rejects unsafe forwarding configuration: %s',
    async (destination) => {
      const message = makeMessage('hello@example.com', 'sender@example.net', 'Failure', 'Body');
      const forward = vi.fn(async () => {});
      message.forward = forward;
      await expect(
        inboundEmail.email(message, {
          ...env,
          INBOUND_CATCH_ALL_MAILBOX: 'admin@example.com',
          INBOUND_FORWARD_TO: destination,
        }),
      ).rejects.toThrow('forwarding');
      expect(forward).not.toHaveBeenCalled();
    },
  );

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
    expect(messages?.raw_object_key).toMatch(/^raw-mime\//);
    const rawObject = await env.ATTACHMENTS.get(messages?.raw_object_key as string);
    expect(rawObject).not.toBeNull();
    expect(await rawObject?.text()).toBe(rawEmail);

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

  it('persists nested MIME attachments in R2 and serves them through mailbox authorization', async () => {
    const db = await migrationsDb();
    const ownerId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    const mailboxId = await createTestMailbox(db, domainId, ownerId, 'inbox');
    const rawEmail = [
      'From: sender@example.com',
      'To: inbox@example.com',
      'Subject: Nested attachment',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Hello=20world',
      '--inner--',
      '--outer',
      'Content-Type: application/octet-stream; name="report.bin"',
      'Content-Disposition: attachment; filename="report.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      'AAEC/w==',
      '--outer--',
      '',
    ].join('\r\n');
    await inboundEmail.email(
      makeMessage('inbox@example.com', 'sender@example.com', 'Nested attachment', rawEmail),
      env,
    );

    const stored = await db
      .prepare('SELECT id, text_body, raw_object_key FROM messages WHERE subject = ?')
      .bind('Nested attachment')
      .first<{ id: string; text_body: string; raw_object_key: string }>();
    expect(stored?.text_body).toContain('Hello world');
    const attachment = await db
      .prepare(
        'SELECT id, object_key, filename, size_bytes FROM inbound_message_attachments WHERE message_id = ?',
      )
      .bind(stored?.id)
      .first<{ id: string; object_key: string; filename: string; size_bytes: number }>();
    expect(attachment?.filename).toBe('report.bin');
    expect(attachment?.size_bytes).toBe(4);
    expect(attachment?.object_key).toMatch(/^inbound-attachment\//);
    const object = await env.ATTACHMENTS.get(attachment?.object_key as string);
    expect(new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([0, 1, 2, 255]),
    );
    const downloaded = await downloadAttachment(
      {
        db,
        cache: getAttachmentByteStore(env),
        objectStore: getAttachmentObjectStore(env),
      },
      { actorUserId: ownerId, mailboxId, attachmentId: attachment?.id as string },
    );
    expect(new Uint8Array(downloaded.bytes)).toEqual(new Uint8Array([0, 1, 2, 255]));
    const otherUserId = crypto.randomUUID();
    await expect(
      downloadAttachment(
        { db, cache: getAttachmentByteStore(env), objectStore: getAttachmentObjectStore(env) },
        { actorUserId: otherUserId, mailboxId, attachmentId: attachment?.id as string },
      ),
    ).rejects.toThrow();
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

    // The SMTP envelope recipient is the known mailbox.
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

  it('routes only the envelope recipient when MIME To names two local mailboxes', async () => {
    const db = await migrationsDb();

    // Setup: create a user, domain, and two mailboxes
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    const mailboxId1 = await createTestMailbox(db, domainId, userId, 'inbox');
    await createTestMailbox(db, domainId, userId, 'support');

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

    // A second delivery callback with support@example.com as message.to
    // would create its own association. The MIME header alone cannot do so.
    const mailboxMessages = await db
      .prepare('SELECT * FROM mailbox_messages WHERE message_id = ? ORDER BY mailbox_id')
      .bind(messages?.id)
      .all();
    expect(mailboxMessages.results).toHaveLength(1);
    expect(mailboxMessages.results?.[0].mailbox_id).toBe(mailboxId1);
  });

  it('rejects a forged MIME To when the envelope recipient has no mailbox', async () => {
    const db = await migrationsDb();
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    await createTestMailbox(db, domainId, userId, 'inbox');
    const rawEmail = `From: sender@example.com
To: inbox@example.com
Subject: Forged recipient

Body`;
    const message = makeMessage('unknown@example.com', 'sender@example.com', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toBe(
      'Unknown recipient. No mailbox found for this address.',
    );
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('delivers a Bcc envelope recipient absent from MIME To and Cc', async () => {
    const db = await migrationsDb();
    const userId = await createTestUser(db);
    const domainId = await createTestDomain(db);
    const mailboxId = await createTestMailbox(db, domainId, userId, 'private');
    const rawEmail = `From: sender@example.com
To: external@example.net
Subject: Private delivery

Body`;
    const message = makeMessage('private@example.com', 'sender@example.com', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toBeNull();
    const row = await db
      .prepare('SELECT mailbox_id FROM mailbox_messages LIMIT 1')
      .first<{ mailbox_id: string }>();
    expect(row?.mailbox_id).toBe(mailboxId);
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
      // CAP-036: role_policies is metadata-only; banEmail/availDomain
      // patterns live in role_policy_ban_emails / role_policy_avail_domains.
      // Insert the metadata row first (FK target), then the child rows.
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO role_policies (role_id, updated_by, updated_at)
           VALUES ('test-owner', ?, datetime('now'))`,
          )
          .bind(userId),
        db
          .prepare(
            `INSERT INTO role_policy_ban_emails (role_id, pattern)
           SELECT 'test-owner', je.value
             FROM json_each(?) AS je
             WHERE je.type = 'text'`,
          )
          .bind(policyJson.ban_email_patterns_json),
        db
          .prepare(
            `INSERT INTO role_policy_avail_domains (role_id, pattern)
           SELECT 'test-owner', je.value
             FROM json_each(?) AS je
             WHERE je.type = 'text'`,
          )
          .bind(policyJson.avail_domain_patterns_json),
      ]);
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

  it('applies sender policy to the envelope sender when RFC From is forged', async () => {
    const db = await migrationsDb();
    await setupMailboxWithRolePolicy({
      ban_email_patterns_json: JSON.stringify(['spammer@example.com']),
      avail_domain_patterns_json: '[]',
    });
    const rawEmail = `From: allowed@example.com
To: inbox@example.com
Subject: Forged sender

Body`;
    const message = makeMessage('inbox@example.com', 'spammer@example.com', 'Test', rawEmail);

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toContain('spammer@example.com');
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(rows?.n).toBe(0);
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
