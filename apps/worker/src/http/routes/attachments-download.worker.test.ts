// CAP-051 Worker-pool tests for consumed attachment downloads and scheduled
// uploaded-row expiry cleanup. D1 and CACHE are real worker bindings.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { createAuditEventWriter } from '../../modules/admin';
import { expireAttachments } from '../../modules/attachments';
import { sweepOrphanedInboundObjects } from '../../modules/messages';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../../platform/cache';
import scheduled from '../../entrypoints/scheduled';

const BYTES = new Uint8Array([0, 255, 1, 254, 2]);

async function clearAttachmentKv(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.CACHE.list({ prefix: 'attachment:', cursor });
    await Promise.all(page.keys.map((key) => env.CACHE.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

async function completeSetup(): Promise<void> {
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at)
       VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at)
       VALUES ('role.manage', 'role.manage', 'Manage roles', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('member', 'member', 'Member', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('administrator', 'administrator', 'Administrator', 1, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('member', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('administrator', 'message.read', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('administrator', 'role.manage', datetime('now'))`,
    ),
  ]);
}

async function createUser(
  email: string,
  role: 'member' | 'administrator' = 'member',
): Promise<string> {
  const userId = crypto.randomUUID();
  const password = await hashPassword('testPassword123');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, email, display_name, status, password_algorithm, password_iterations,
         password_salt, password_hash, created_at, updated_at
       ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      email,
      email,
      password.algorithm,
      password.iterations,
      password.salt,
      password.hash,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`).bind(
      userId,
      role,
      now,
    ),
  ]);
  return userId;
}

async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken));
  const hashHex = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      userId,
      hashHex,
      Math.floor(Date.now() / 1000) + 86_400,
      new Date().toISOString(),
    )
    .run();
  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId, sessionId }), {
    expirationTtl: 900,
  });
  return accessToken;
}

async function createMailbox(ownerUserId: string, localPart = 'inbox'): Promise<string> {
  const domainId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
       VALUES (?, ?, 'active', NULL, ?, ?)`,
    ).bind(domainId, `${domainId}.example`, now, now),
    env.DB.prepare(
      `INSERT INTO mailboxes (
         id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', 'active', ?, ?)`,
    ).bind(mailboxId, domainId, ownerUserId, localPart, now, now),
  ]);
  return mailboxId;
}

async function addMember(mailboxId: string, userId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
     VALUES (?, ?, 'viewer', ?)`,
  )
    .bind(mailboxId, userId, new Date().toISOString())
    .run();
}

async function seedConsumedAttachment(
  ownerUserId: string,
  mailboxId: string,
  options: { readonly inline?: boolean; readonly softDeleted?: boolean } = {},
): Promise<{ attachmentId: string; messageId: string; uploadId: string; kvKey: string }> {
  const attachmentId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const mailboxMessageId = crypto.randomUUID();
  const uploadId = crypto.randomUUID();
  const kvKey = `attachment:${uploadId}`;
  const now = '2026-08-29 00:00:00';
  const disposition = options.inline ? 'inline' : 'attachment';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (
         id, from_address, from_name, subject, html_body, text_body,
         status, created_by_user_id, created_at, updated_at
       ) VALUES (?, 'sender@example.com', 'Sender', 'subject', '', '', 'delivered', ?, ?, ?)`,
    ).bind(messageId, ownerUserId, now, now),
    env.DB.prepare(
      `INSERT INTO mailbox_messages (
         id, mailbox_id, message_id, is_read, is_starred, folder, created_at
       ) VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
    ).bind(mailboxMessageId, mailboxId, messageId, now),
    env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', '2099-01-01 00:00:00', NULL, ?)`,
    ).bind(
      uploadId,
      ownerUserId,
      mailboxId,
      kvKey,
      options.inline ? 'logo.png' : 'report.pdf',
      options.inline ? 'image/png' : 'application/pdf',
      disposition,
      BYTES.byteLength,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO message_attachments (
         id, message_id, upload_id, object_key, filename, content_type,
         size_bytes, disposition, content_id, sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(
      attachmentId,
      messageId,
      uploadId,
      kvKey,
      options.inline ? 'logo.png' : 'report.pdf',
      options.inline ? 'image/png' : 'application/pdf',
      BYTES.byteLength,
      disposition,
      now,
    ),
  ]);
  await env.DB.prepare(
    `UPDATE attachment_uploads SET status = 'consumed', consumed_at = ? WHERE id = ?`,
  )
    .bind(now, uploadId)
    .run();
  if (options.softDeleted) {
    await env.DB.prepare(
      `INSERT INTO message_user_state (
         mailbox_message_id, user_id, is_read, updated_at, is_deleted, deleted_at
       ) VALUES (?, ?, 0, ?, 1, ?)`,
    )
      .bind(mailboxMessageId, ownerUserId, now, now)
      .run();
  }
  await env.CACHE.put(kvKey, BYTES, { expirationTtl: 3600 });
  return { attachmentId, messageId, uploadId, kvKey };
}

async function seedExpiredUpload(ownerUserId: string, mailboxId: string): Promise<string> {
  const uploadId = crypto.randomUUID();
  const kvKey = `attachment:${uploadId}`;
  await env.DB.prepare(
    `INSERT INTO attachment_uploads (
       id, owner_user_id, mailbox_id, kv_key, filename, content_type,
       disposition, size_bytes, status, expires_at, consumed_at, created_at
     ) VALUES (?, ?, ?, ?, 'expired.pdf', 'application/pdf', 'attachment', ?, 'uploaded', ?, NULL, ?)`,
  )
    .bind(
      uploadId,
      ownerUserId,
      mailboxId,
      kvKey,
      BYTES.byteLength,
      '2026-08-28 23:59:00',
      '2026-08-28 00:00:00',
    )
    .run();
  await env.CACHE.put(kvKey, BYTES, { expirationTtl: 3600 });
  return uploadId;
}

function downloadUrl(mailboxId: string, attachmentId: string): string {
  return `http://localhost/api/v1/mailboxes/${mailboxId}/attachments/${attachmentId}/download`;
}

function controller(): Parameters<typeof scheduled.scheduled>[0] {
  return {
    cron: '*/5 * * * *',
    scheduledTime: Date.UTC(2026, 9, 9, 12, 0),
    noRetry() {},
  } as unknown as Parameters<typeof scheduled.scheduled>[0];
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetAndMigrate();
  await clearAttachmentKv();
  await completeSetup();
});

describe('GET /api/v1/mailboxes/:mailboxId/attachments/:attachmentId/download', () => {
  it('R-ATTACHMENT-001/005 returns exact bytes and canonical safe headers', async () => {
    const ownerId = await createUser('download-owner@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId);
    const attachment = await seedConsumedAttachment(ownerId, mailboxId, { inline: true });

    const response = await SELF.fetch(downloadUrl(mailboxId, attachment.attachmentId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Length')).toBe(String(BYTES.byteLength));
    expect(response.headers.get('Content-Disposition')).toBe(
      `attachment; filename="logo.png"; filename*=UTF-8''%6C%6F%67%6F%2E%70%6E%67`,
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(BYTES));
  });

  it('reads a consumed attachment from R2 after its KV staging key expires', async () => {
    const ownerId = await createUser('download-r2@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId);
    const attachment = await seedConsumedAttachment(ownerId, mailboxId);
    await env.ATTACHMENTS.put(attachment.kvKey, BYTES);
    await env.CACHE.delete(attachment.kvKey);

    const response = await SELF.fetch(downloadUrl(mailboxId, attachment.attachmentId), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(BYTES));
    await env.ATTACHMENTS.delete(attachment.kvKey);
  });

  it('R-AUTHZ-003/004 gives authorized viewers access and foreign users one safe 404', async () => {
    const ownerId = await createUser('download-owner-2@example.com');
    const ownerToken = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId);
    const attachment = await seedConsumedAttachment(ownerId, mailboxId);
    const viewerId = await createUser('download-viewer@example.com');
    const viewerToken = await createSession(viewerId);
    await addMember(mailboxId, viewerId);

    const viewerResponse = await SELF.fetch(downloadUrl(mailboxId, attachment.attachmentId), {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerResponse.status).toBe(200);

    const strangerId = await createUser('download-stranger@example.com');
    const strangerToken = await createSession(strangerId);
    const foreignResponse = await SELF.fetch(downloadUrl(mailboxId, attachment.attachmentId), {
      headers: { Authorization: `Bearer ${strangerToken}` },
    });
    expect(foreignResponse.status).toBe(404);
    expect(await foreignResponse.json()).toMatchObject({
      error: { code: 'MESSAGE_NOT_FOUND', message: 'Attachment not found' },
    });

    const ownerResponse = await SELF.fetch(downloadUrl(mailboxId, attachment.attachmentId), {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(ownerResponse.status).toBe(200);
  });

  it('does not expose attachment bytes to an administrator without mailbox membership', async () => {
    const ownerId = await createUser('download-owner-admin-boundary@example.com');
    const adminId = await createUser('download-admin-boundary@example.com', 'administrator');
    const adminToken = await createSession(adminId);
    const mailboxId = await createMailbox(ownerId);
    const attachment = await seedConsumedAttachment(ownerId, mailboxId);
    const url = downloadUrl(mailboxId, attachment.attachmentId);

    const denied = await SELF.fetch(url, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(denied.status).toBe(404);
    expect((await denied.json()).error.code).toBe('MESSAGE_NOT_FOUND');

    await addMember(mailboxId, adminId);
    const granted = await SELF.fetch(url, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(granted.status).toBe(200);
    expect(Array.from(new Uint8Array(await granted.arrayBuffer()))).toEqual(Array.from(BYTES));
  });

  it('R-ATTACHMENT-005/R-AUTHZ-004 collapses missing, soft-deleted, and CACHE-missing states', async () => {
    const ownerId = await createUser('download-safe@example.com');
    const token = await createSession(ownerId);
    const mailboxId = await createMailbox(ownerId);
    const softDeleted = await seedConsumedAttachment(ownerId, mailboxId, { softDeleted: true });
    const cacheMissing = await seedConsumedAttachment(ownerId, mailboxId);
    await env.CACHE.delete(cacheMissing.kvKey);

    const requests = [
      SELF.fetch(downloadUrl(mailboxId, crypto.randomUUID()), {
        headers: { Authorization: `Bearer ${token}` },
      }),
      SELF.fetch(downloadUrl(mailboxId, softDeleted.attachmentId), {
        headers: { Authorization: `Bearer ${token}` },
      }),
      SELF.fetch(downloadUrl(mailboxId, cacheMissing.attachmentId), {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    const bodies = await Promise.all(
      responses.map(async (response) => {
        const body = (await response.json()) as { error: Record<string, unknown> };
        return { ...body.error, requestId: '<normalized>' };
      }),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]).toMatchObject({ code: 'MESSAGE_NOT_FOUND', message: 'Attachment not found' });
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM audit_events`).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });
});

describe('attachment expiry cleanup', () => {
  it('R-ATTACHMENT-007 daily scanning removes late R2 writes after checkpoint while protecting live uploads', async () => {
    const ownerId = await createUser('expiry-late-r2@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    const consumed = await seedConsumedAttachment(ownerId, mailboxId);
    const pendingId = await seedExpiredUpload(ownerId, mailboxId);
    await env.DB.prepare(
      "UPDATE attachment_uploads SET expires_at='2099-01-01 00:00:00' WHERE id=?",
    )
      .bind(pendingId)
      .run();
    const key = `attachment:${uploadId}`;
    await expireAttachments(
      {
        db: env.DB,
        cache: getAttachmentByteStore(env),
        objectStore: getAttachmentObjectStore(env),
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00Z') },
    );
    expect(
      await env.DB.prepare('SELECT cleanup_completed_at FROM attachment_uploads WHERE id=?')
        .bind(uploadId)
        .first(),
    ).toEqual({ cleanup_completed_at: '2026-08-29 00:00:00' });
    // Simulate a compose copy landing after cleanup's final storage read.
    await env.ATTACHMENTS.put(key, BYTES);
    await env.ATTACHMENTS.put(consumed.kvKey, BYTES);
    await env.ATTACHMENTS.put(`attachment:${pendingId}`, BYTES);
    const dependencies = { db: env.DB, objectStore: env.ATTACHMENTS, cursorStore: env.CACHE };
    expect((await sweepOrphanedInboundObjects(dependencies)).deleted).toBe(0);
    const future = new Date(Date.now() + 2 * 86400_000);
    expect(await sweepOrphanedInboundObjects(dependencies, future)).toEqual({
      scanned: 3,
      deleted: 1,
      failed: 0,
    });
    expect(await env.ATTACHMENTS.get(key)).toBeNull();
    expect(await env.ATTACHMENTS.get(consumed.kvKey)).not.toBeNull();
    expect(await env.ATTACHMENTS.get(`attachment:${pendingId}`)).not.toBeNull();
  });

  it('R-ATTACHMENT-007 checkpoints both stores and never probes completed rows again', async () => {
    const ownerId = await createUser('expiry-checkpoint@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    const key = `attachment:${uploadId}`;
    await env.ATTACHMENTS.put(key, BYTES);
    const cache = getAttachmentByteStore(env);
    const objectStore = getAttachmentObjectStore(env);
    const dependencies = {
      db: env.DB,
      cache,
      objectStore,
      auditEventWriter: createAuditEventWriter(env.DB),
    };
    const input = { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00Z') };
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 1,
      expired: 1,
      failed: 0,
    });
    expect(await env.CACHE.get(key)).toBeNull();
    expect(await env.ATTACHMENTS.get(key)).toBeNull();
    expect(
      await env.DB.prepare('SELECT cleanup_completed_at FROM attachment_uploads WHERE id=?')
        .bind(uploadId)
        .first(),
    ).toEqual({ cleanup_completed_at: '2026-08-29 00:00:00' });
    const kvRead = vi.spyOn(cache, 'get');
    const r2Read = vi.spyOn(objectStore, 'get');
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 0,
      expired: 0,
      failed: 0,
    });
    expect(kvRead).not.toHaveBeenCalled();
    expect(r2Read).not.toHaveBeenCalled();
  });

  it('R-ATTACHMENT-007 retries a failed completion write after storage is already gone', async () => {
    const ownerId = await createUser('expiry-marker-retry@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    await env.DB.prepare(
      `CREATE TRIGGER abort_cleanup_checkpoint
      BEFORE UPDATE OF cleanup_completed_at ON attachment_uploads
      BEGIN SELECT RAISE(ABORT, 'checkpoint unavailable'); END`,
    ).run();
    const dependencies = {
      db: env.DB,
      cache: getAttachmentByteStore(env),
      objectStore: getAttachmentObjectStore(env),
      auditEventWriter: createAuditEventWriter(env.DB),
    };
    const input = { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00Z') };
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 1,
      expired: 1,
      failed: 1,
    });
    expect(await env.CACHE.get(`attachment:${uploadId}`)).toBeNull();
    expect(
      await env.DB.prepare('SELECT status, cleanup_completed_at FROM attachment_uploads WHERE id=?')
        .bind(uploadId)
        .first(),
    ).toEqual({ status: 'expired', cleanup_completed_at: null });
    await env.DB.prepare('DROP TRIGGER abort_cleanup_checkpoint').run();
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 1,
      expired: 0,
      failed: 0,
    });
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 0,
      expired: 0,
      failed: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM audit_events WHERE action='attachment.expired'",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('R-ATTACHMENT-007 bounds each tick to 100 uploads and drains the remainder on the next tick', async () => {
    const ownerId = await createUser('expiry-batch@example.com');
    const mailboxId = await createMailbox(ownerId);
    for (let index = 0; index < 101; index++) await seedExpiredUpload(ownerId, mailboxId);
    const dependencies = {
      db: env.DB,
      cache: getAttachmentByteStore(env),
      objectStore: getAttachmentObjectStore(env),
      auditEventWriter: createAuditEventWriter(env.DB),
    };
    const input = { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00Z') };
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 100,
      expired: 100,
      failed: 0,
    });
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 1,
      expired: 1,
      failed: 0,
    });
    expect(await expireAttachments(dependencies, input)).toEqual({
      found: 0,
      expired: 0,
      failed: 0,
    });
  });

  it('R-ATTACHMENT-007/R-AUDIT-001 removes bytes, transitions once, and correlates one audit', async () => {
    const ownerId = await createUser('expiry-owner@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    const requestId = crypto.randomUUID();

    const result = await expireAttachments(
      {
        db: env.DB,
        cache: getAttachmentByteStore(env),
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId, now: new Date('2026-08-29T00:00:00.000Z') },
    );
    expect(result).toEqual({ found: 1, expired: 1, failed: 0 });
    expect(await env.CACHE.get(`attachment:${uploadId}`, 'arrayBuffer')).toBeNull();
    expect(
      await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
        .bind(uploadId)
        .first<{ status: string }>(),
    ).toMatchObject({ status: 'expired' });
    const audit = await env.DB.prepare(
      `SELECT action, resource_type, resource_id, request_id, metadata
         FROM audit_events WHERE action = 'attachment.expired'`,
    ).first<{
      action: string;
      resource_type: string;
      resource_id: string;
      request_id: string;
      metadata: string | null;
    }>();
    expect(audit).toEqual({
      action: 'attachment.expired',
      resource_type: 'attachment_upload',
      resource_id: uploadId,
      request_id: requestId,
      metadata: null,
    });

    const replay = await expireAttachments(
      {
        db: env.DB,
        cache: getAttachmentByteStore(env),
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00.000Z') },
    );
    expect(replay).toEqual({ found: 0, expired: 0, failed: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.expired'`,
      ).first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
  });

  it('R-ATTACHMENT-007 retries CACHE deletion after the D1 expiry transition', async () => {
    const ownerId = await createUser('expiry-retry@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    const realCache = getAttachmentByteStore(env);
    const failingCache = {
      ...realCache,
      delete: vi.fn(async () => {
        throw new Error('transient cache failure');
      }),
    };

    const failed = await expireAttachments(
      {
        db: env.DB,
        cache: failingCache,
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00.000Z') },
    );
    expect(failed).toEqual({ found: 1, expired: 1, failed: 1 });
    expect(await env.CACHE.get(`attachment:${uploadId}`, 'arrayBuffer')).not.toBeNull();
    expect(
      await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
        .bind(uploadId)
        .first<{ status: string }>(),
    ).toMatchObject({ status: 'expired' });

    const retried = await expireAttachments(
      {
        db: env.DB,
        cache: realCache,
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00.000Z') },
    );
    expect(retried).toEqual({ found: 1, expired: 0, failed: 0 });
  });

  it('R-AUDIT-001 keeps the row retryable when the D1 transition batch fails', async () => {
    const ownerId = await createUser('expiry-d1-retry@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    await env.DB.prepare(
      `CREATE TRIGGER cap051_abort_expiry
       BEFORE UPDATE OF status ON attachment_uploads
       WHEN NEW.status = 'expired'
       BEGIN SELECT RAISE(ABORT, 'cap051 deterministic failure'); END`,
    ).run();

    const failed = await expireAttachments(
      {
        db: env.DB,
        cache: getAttachmentByteStore(env),
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00.000Z') },
    );
    expect(failed).toEqual({ found: 1, expired: 0, failed: 1 });
    expect(await env.CACHE.get(`attachment:${uploadId}`, 'arrayBuffer')).not.toBeNull();
    expect(
      await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
        .bind(uploadId)
        .first<{ status: string }>(),
    ).toMatchObject({ status: 'uploaded' });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.expired'`,
      ).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it('R-ATTACHMENT-007/R-AUDIT-001 races two cleanup ticks without consuming bytes or duplicating audit', async () => {
    const ownerId = await createUser('expiry-race@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);
    const dependencies = {
      db: env.DB,
      cache: getAttachmentByteStore(env),
      auditEventWriter: createAuditEventWriter(env.DB),
    };

    const [first, second] = await Promise.all([
      expireAttachments(dependencies, {
        requestId: crypto.randomUUID(),
        now: new Date('2026-08-29T00:00:00.000Z'),
      }),
      expireAttachments(dependencies, {
        requestId: crypto.randomUUID(),
        now: new Date('2026-08-29T00:00:00.000Z'),
      }),
    ]);
    expect(first.expired + second.expired).toBe(1);
    expect(await env.CACHE.get(`attachment:${uploadId}`, 'arrayBuffer')).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'attachment.expired' AND resource_id = ?`,
      )
        .bind(uploadId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
  });

  it('R-ATTACHMENT-007 never reclaims CACHE bytes for a consumed upload', async () => {
    const ownerId = await createUser('expiry-consumed@example.com');
    const mailboxId = await createMailbox(ownerId);
    const consumed = await seedConsumedAttachment(ownerId, mailboxId);

    const result = await expireAttachments(
      {
        db: env.DB,
        cache: getAttachmentByteStore(env),
        auditEventWriter: createAuditEventWriter(env.DB),
      },
      { requestId: crypto.randomUUID(), now: new Date('2026-08-29T00:00:00.000Z') },
    );
    expect(result).toEqual({ found: 0, expired: 0, failed: 0 });
    expect(await env.CACHE.get(consumed.kvKey, 'arrayBuffer')).not.toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.expired'`,
      ).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it('R-WORKFLOW-005 wires cleanup into the existing scheduled entrypoint', async () => {
    const ownerId = await createUser('expiry-scheduled@example.com');
    const mailboxId = await createMailbox(ownerId);
    const uploadId = await seedExpiredUpload(ownerId, mailboxId);

    await scheduled.scheduled(controller(), env);

    expect(await env.CACHE.get(`attachment:${uploadId}`, 'arrayBuffer')).toBeNull();
    expect(
      await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
        .bind(uploadId)
        .first<{ status: string }>(),
    ).toMatchObject({ status: 'expired' });
  });
});
