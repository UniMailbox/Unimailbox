// CAP-052 message-detail attachment projection.
// Real Worker coverage for the additive metadata-only `attachments` field.

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at)
       VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at)
       VALUES ('mailbox.create', 'mailbox.create', 'Create mailboxes', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at)
       VALUES ('role.manage', 'role.manage', 'Manage roles', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('administrator', 'administrator', 'Full system access', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('member', 'member', 'Standard user', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('administrator', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('administrator', 'mailbox.create', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('administrator', 'role.manage', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('member', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('member', 'mailbox.create', datetime('now'))`,
    ),
  ]);
}

async function createUser(email: string): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm,
         password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, 'Test user', 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      email,
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'member', ?)`,
    ).bind(userId, now),
  ]);
  return userId;
}

async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken));
  const refreshTokenHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      userId,
      refreshTokenHash,
      Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      new Date().toISOString(),
    )
    .run();
  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId, sessionId }), {
    expirationTtl: 15 * 60,
  });
  return accessToken;
}

async function createDomain(name: string): Promise<string> {
  const domainId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
     VALUES (?, ?, 'active', NULL, ?, ?)`,
  )
    .bind(domainId, name, now, now)
    .run();
  return domainId;
}

async function createMailbox(ownerUserId: string, localPart: string): Promise<string> {
  const mailboxId = crypto.randomUUID();
  const domainId = await createDomain(`${localPart}.example.com`);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'active', ?, ?)`,
  )
    .bind(mailboxId, domainId, ownerUserId, localPart, now, now)
    .run();
  return mailboxId;
}

async function insertMessage(mailboxId: string, ownerUserId: string): Promise<string> {
  const messageId = crypto.randomUUID();
  const mailboxMessageId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const createdAt = '2026-01-01 00:00:00';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body,
         thread_id, message_id_header, in_reply_to_header, references_header, status,
         received_at, created_at, updated_at, created_by_user_id)
       VALUES (?, 'sender@example.com', 'Sender', 'Detail', '<p>body</p>', 'body',
         NULL, NULL, NULL, '', 'delivered', ?, ?, ?, ?)`,
    ).bind(messageId, createdAt, createdAt, createdAt, ownerUserId),
    env.DB.prepare(
      `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred,
         folder, created_at)
       VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
    ).bind(mailboxMessageId, mailboxId, messageId, createdAt),
    env.DB.prepare(
      `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
       VALUES (?, ?, 'recipient@example.com', 'Recipient', 'to', ?)`,
    ).bind(recipientId, messageId, createdAt),
  ]);
  return messageId;
}

interface SeedAttachment {
  readonly id: string;
  readonly uploadId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId: string | null;
  readonly createdAt: string;
  readonly status: 'uploaded' | 'consumed';
}

async function insertAttachments(
  messageId: string,
  ownerUserId: string,
  mailboxId: string,
  attachments: ReadonlyArray<SeedAttachment>,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const attachment of attachments) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachment_uploads (
           id, owner_user_id, mailbox_id, kv_key, filename, content_type,
           disposition, size_bytes, status, expires_at, consumed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', '2099-01-01 00:00:00', NULL, ?)`,
      ).bind(
        attachment.uploadId,
        ownerUserId,
        mailboxId,
        `attachment:${attachment.uploadId}`,
        attachment.filename,
        attachment.contentType,
        attachment.disposition,
        attachment.sizeBytes,
        attachment.createdAt,
      ),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO message_attachments (
           id, message_id, upload_id, object_key, filename, content_type,
           size_bytes, disposition, content_id, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).bind(
        attachment.id,
        messageId,
        attachment.uploadId,
        `attachment:${attachment.uploadId}`,
        attachment.filename,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.disposition,
        attachment.contentId,
        attachment.createdAt,
      ),
    );
    if (attachment.status === 'consumed') {
      statements.push(
        env.DB.prepare(
          `UPDATE attachment_uploads SET status = 'consumed', consumed_at = ? WHERE id = ?`,
        ).bind(attachment.createdAt, attachment.uploadId),
      );
    }
  }
  await env.DB.batch(statements);
}

function detailUrl(mailboxId: string, messageId: string): string {
  return `http://localhost/api/v1/mailboxes/${mailboxId}/messages/${messageId}`;
}

describe('CAP-052 message-detail attachments', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await completeSetup();
  });

  it('R-ATTACHMENT-001/R-API-001 always returns an empty attachment array when none are consumed', async () => {
    const ownerId = await createUser('cap052-empty@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId, 'empty');
    const messageId = await insertMessage(mailboxId, ownerId);

    const response = await SELF.fetch(detailUrl(mailboxId, messageId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.attachments).toEqual([]);
  });

  it('R-ATTACHMENT-001/R-DATA-004/R-SECRET-003/R-LOG-001 returns ordered safe metadata', async () => {
    const ownerId = await createUser('cap052-populated@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId, 'populated');
    const messageId = await insertMessage(mailboxId, ownerId);
    const first = {
      id: '00000000-0000-4000-8000-000000000012',
      uploadId: crypto.randomUUID(),
      filename: 'later.txt',
      contentType: 'text/plain',
      sizeBytes: 12,
      disposition: 'attachment' as const,
      contentId: null,
      createdAt: '2026-01-02 00:00:00',
      status: 'consumed' as const,
    };
    const second = {
      id: '00000000-0000-4000-8000-000000000011',
      uploadId: crypto.randomUUID(),
      filename: 'first.png',
      contentType: 'image/png',
      sizeBytes: 24,
      disposition: 'inline' as const,
      contentId: 'cid-first',
      createdAt: '2026-01-01 00:00:00',
      status: 'consumed' as const,
    };
    const third = {
      id: '00000000-0000-4000-8000-000000000013',
      uploadId: crypto.randomUUID(),
      filename: 'same-time.pdf',
      contentType: 'application/pdf',
      sizeBytes: 36,
      disposition: 'attachment' as const,
      contentId: null,
      createdAt: '2026-01-01 00:00:00',
      status: 'consumed' as const,
    };
    const sensitiveFilename = 'sentinel-private-filename.txt';
    const sensitiveObjectKey = 'attachment:00000000-0000-4000-8000-000000000098';
    const sensitiveBytes = 'sentinel-private-attachment-bytes';
    const sensitiveIdempotencyValue = 'Idempotency-Key: sentinel-private-value';
    const hiddenUploaded = {
      id: '00000000-0000-4000-8000-000000000099',
      uploadId: '00000000-0000-4000-8000-000000000098',
      filename: sensitiveFilename,
      contentType: 'text/plain',
      sizeBytes: sensitiveBytes.length,
      disposition: 'attachment' as const,
      contentId: sensitiveIdempotencyValue,
      createdAt: '2026-01-03 00:00:00',
      status: 'uploaded' as const,
    };
    await insertAttachments(messageId, ownerId, mailboxId, [first, third, second, hiddenUploaded]);
    await env.CACHE.put(sensitiveObjectKey, sensitiveBytes);

    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    let response: Response;
    let consoleText = '';
    try {
      response = await SELF.fetch(detailUrl(mailboxId, messageId), {
        headers: { Authorization: `Bearer ${token}` },
      });
      // Capture the calls before mockRestore(); Vitest 4 clears mock.calls
      // during restore, which would otherwise make this security assertion
      // falsely green.
      consoleText = consoleSpies
        .flatMap((spy) => spy.mock.calls)
        .map((call) => JSON.stringify(call))
        .join(' ');
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.attachments).toEqual([
      {
        id: second.id,
        filename: second.filename,
        contentType: second.contentType,
        sizeBytes: second.sizeBytes,
        disposition: second.disposition,
        contentId: second.contentId,
      },
      {
        id: third.id,
        filename: third.filename,
        contentType: third.contentType,
        sizeBytes: third.sizeBytes,
        disposition: third.disposition,
        contentId: third.contentId,
      },
      {
        id: first.id,
        filename: first.filename,
        contentType: first.contentType,
        sizeBytes: first.sizeBytes,
        disposition: first.disposition,
        contentId: first.contentId,
      },
    ]);

    const descriptors = body.data.attachments as Array<Record<string, unknown>>;
    expect(Object.keys(descriptors[0] ?? {}).sort()).toEqual([
      'contentId',
      'contentType',
      'disposition',
      'filename',
      'id',
      'sizeBytes',
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor).not.toHaveProperty('uploadId');
      expect(descriptor).not.toHaveProperty('objectKey');
      expect(descriptor).not.toHaveProperty('bytes');
    }
    const responseText = JSON.stringify(body);
    expect(responseText).not.toContain(sensitiveFilename);
    expect(responseText).not.toContain(sensitiveObjectKey);
    expect(responseText).not.toContain(sensitiveBytes);
    expect(responseText).not.toContain(sensitiveIdempotencyValue);
    expect(consoleText).not.toContain(sensitiveFilename);
    expect(consoleText).not.toContain(sensitiveObjectKey);
    expect(consoleText).not.toContain(sensitiveBytes);
    expect(consoleText).not.toContain(sensitiveIdempotencyValue);
  });

  it('R-ATTACHMENT-006 excludes relations whose upload is not consumed', async () => {
    const ownerId = await createUser('cap052-state@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId, 'state');
    const messageId = await insertMessage(mailboxId, ownerId);
    const consumed = {
      id: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      filename: 'consumed.txt',
      contentType: 'text/plain',
      sizeBytes: 5,
      disposition: 'attachment' as const,
      contentId: null,
      createdAt: '2026-01-01 00:00:00',
      status: 'consumed' as const,
    };
    const uploaded = {
      id: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      filename: 'still-uploaded.txt',
      contentType: 'text/plain',
      sizeBytes: 8,
      disposition: 'attachment' as const,
      contentId: null,
      createdAt: '2026-01-02 00:00:00',
      status: 'uploaded' as const,
    };
    await insertAttachments(messageId, ownerId, mailboxId, [consumed, uploaded]);

    const response = await SELF.fetch(detailUrl(mailboxId, messageId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.attachments).toEqual([
      expect.objectContaining({ id: consumed.id, filename: consumed.filename }),
    ]);
    expect(body.data.attachments).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: uploaded.id })]),
    );
  });

  it('R-AUTHZ-003/R-AUTHZ-004/R-MESSAGE-003/R-MESSAGE-005/R-API-002 keeps cross-mailbox and soft-deleted details at 404', async () => {
    const ownerId = await createUser('cap052-authz@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId, 'visible');
    const otherMailboxId = await createMailbox(ownerId, 'other');
    const messageId = await insertMessage(mailboxId, ownerId);
    const attachment = {
      id: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      filename: 'private.txt',
      contentType: 'text/plain',
      sizeBytes: 7,
      disposition: 'attachment' as const,
      contentId: null,
      createdAt: '2026-01-01 00:00:00',
      status: 'consumed' as const,
    };
    await insertAttachments(messageId, ownerId, mailboxId, [attachment]);

    const foreignResponse = await SELF.fetch(detailUrl(otherMailboxId, messageId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(foreignResponse.status).toBe(404);
    expect((await foreignResponse.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    const visibleMailboxMessage = await env.DB.prepare(
      `SELECT id FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?`,
    )
      .bind(mailboxId, messageId)
      .first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO message_user_state (
         mailbox_message_id, user_id, is_read, read_at, is_deleted, deleted_at, updated_at
       ) VALUES (?, ?, 0, NULL, 1, datetime('now'), datetime('now'))`,
    )
      .bind(visibleMailboxMessage?.id, ownerId)
      .run();

    const softDeletedResponse = await SELF.fetch(detailUrl(mailboxId, messageId), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(softDeletedResponse.status).toBe(404);
    expect((await softDeletedResponse.json()).error.code).toBe('MESSAGE_NOT_FOUND');
  });
});
