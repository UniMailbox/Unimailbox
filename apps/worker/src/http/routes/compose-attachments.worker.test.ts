// compose-attachments.worker.test.ts — CAP-050 acceptance tests for the
// compose (send) endpoint consuming CAP-049-staged attachments.
//
// Worker-pool tests that exercise the full request pipeline: CAP-049
// upload → POST /api/v1/mailboxes/:mailboxId/messages/send → D1 batch
// → OUTBOUND queue → processOutboundJob → mock adapter. Real D1, real
// KV, real Queue bindings; provider HTTP mocked at the OutboundProviderAdapter
// seam per .claude/rules/testing.md §Mocking.

import { beforeEach, expect, it, vi, afterEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
  parseProviderKey,
  estimateEmailBytes,
  OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES,
} from '@unimailbox/contracts';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import type {
  OutboundProviderAdapter,
  SendProviderMessage,
  EditorAssetDescriptor,
} from '@unimailbox/contracts';
import { hashPassword, importEncryptionKey, encrypt } from '../../platform/crypto';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../../platform/cache';
import { processOutboundJob } from '../../modules/outbound-mail';
import { brevoAdapter } from '../../integrations/providers/brevo';

const ENCRYPTION_KEY = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Seeding helpers — small subset of the compose.worker.test.ts fixtures,
// trimmed to what CAP-050 needs (sender role + provider connection).
// ---------------------------------------------------------------------------

const UPLOAD_BYTES_A = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
const UPLOAD_BYTES_B = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x03, 0x04]);

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
       VALUES ('message.send', 'message.send', 'Send messages', datetime('now'))`,
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
       VALUES ('administrator', 'message.send', datetime('now'))`,
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
       VALUES ('member', 'message.send', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('member', 'mailbox.create', datetime('now'))`,
    ),
  ]);
}

async function createUserWithRole(
  roleName: 'administrator' | 'member',
  email: string,
): Promise<string> {
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword('testPassword123');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      email,
      `${roleName} user`,
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    ),
    env.DB.prepare(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`).bind(
      userId,
      roleName,
      now,
    ),
  ]);
  return userId;
}

async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  const refreshTokenHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(refreshToken))),
  )
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const sessionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(sessionId, userId, refreshTokenHash, Math.floor(Date.now() / 1000) + 86_400, now())
    .run();
  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId, sessionId }), {
    expirationTtl: 900,
  });
  return accessToken;
}

function now(): string {
  return new Date().toISOString();
}

async function createDomain(name = 'example.com'): Promise<string> {
  const domainId = crypto.randomUUID();
  const t = now().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
     VALUES (?, ?, 'active', NULL, ?, ?)`,
  )
    .bind(domainId, name, t, t)
    .run();
  return domainId;
}

async function createMailbox(
  domainId: string,
  ownerUserId: string,
  localPart = 'inbox',
): Promise<string> {
  const mailboxId = crypto.randomUUID();
  const t = now().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'active', ?, ?)`,
  )
    .bind(mailboxId, domainId, ownerUserId, localPart, t, t)
    .run();
  return mailboxId;
}

async function createActiveProviderConnection(): Promise<string> {
  const t = now().slice(0, 19).replace('T', ' ');
  const connectionId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const key = await importEncryptionKey(ENCRYPTION_KEY);
  const encrypted = await encrypt('test-brevo-api-key', key);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, 'brevo-api-key', 1, ?, ?, ?, ?, ?)`,
    ).bind(credentialId, encrypted.ciphertext, encrypted.iv, encrypted.authTag, t, t),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
       VALUES (?, 'brevo', 'Brevo', ?, 'active', ?, ?)`,
    ).bind(connectionId, credentialId, t, t),
    env.DB.prepare(
      `UPDATE managed_domains
          SET outbound_connection_id = ?, updated_at = ?
        WHERE id = (SELECT id FROM managed_domains ORDER BY created_at ASC, id ASC LIMIT 1)`,
    ).bind(connectionId, t),
  ]);
  return connectionId;
}

interface UploadedDescriptor {
  readonly uploadId: string;
  readonly sizeBytes: number;
  readonly disposition: 'attachment' | 'inline';
  readonly contentType: string;
  readonly filename: string;
}

async function uploadAttachment(
  mailboxId: string,
  ownerUserId: string,
  bytes: Uint8Array,
  options: {
    readonly filename?: string;
    readonly contentType?: string;
    readonly disposition?: 'attachment' | 'inline';
  } = {},
): Promise<UploadedDescriptor> {
  const uploadId = crypto.randomUUID();
  const filename = options.filename ?? 'evidence.bin';
  const contentType = options.contentType ?? 'application/octet-stream';
  const disposition = options.disposition ?? 'attachment';
  const t = now().slice(0, 19).replace('T', ' ');
  // 1h expiry, far enough in the future.
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, NULL, ?)`,
    ).bind(
      uploadId,
      ownerUserId,
      mailboxId,
      `attachment:${uploadId}`,
      filename,
      contentType,
      disposition,
      bytes.byteLength,
      expiresAt,
      t,
    ),
  ]);
  // CAP-049 owns the KV put at the route layer; tests pre-stage both D1
  // and KV so we exercise the same observable state without replaying
  // the upload route's body-parser pipeline.
  await env.CACHE.put(`attachment:${uploadId}`, bytes, { expirationTtl: 3600 });
  return { uploadId, sizeBytes: bytes.byteLength, disposition, contentType, filename };
}

async function uploadExpired(
  mailboxId: string,
  ownerUserId: string,
  bytes: Uint8Array,
): Promise<string> {
  const uploadId = crypto.randomUUID();
  const t = now().slice(0, 19).replace('T', ' ');
  const expiresAt = new Date(Date.now() - 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, 'expired.bin', 'application/octet-stream',
                 'attachment', ?, 'uploaded', ?, NULL, ?)`,
    ).bind(
      uploadId,
      ownerUserId,
      mailboxId,
      `attachment:${uploadId}`,
      bytes.byteLength,
      expiresAt,
      t,
    ),
  ]);
  await env.CACHE.put(`attachment:${uploadId}`, bytes, { expirationTtl: 60 });
  return uploadId;
}

async function uploadConsumed(
  mailboxId: string,
  ownerUserId: string,
  bytes: Uint8Array,
): Promise<string> {
  const uploadId = crypto.randomUUID();
  const t = now().slice(0, 19).replace('T', ' ');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, 'consumed.bin', 'application/octet-stream',
                 'attachment', ?, 'consumed', datetime('now', '+1 hour'), ?, ?)`,
    ).bind(uploadId, ownerUserId, mailboxId, `attachment:${uploadId}`, bytes.byteLength, t, t),
  ]);
  await env.CACHE.put(`attachment:${uploadId}`, bytes, { expirationTtl: 3600 });
  return uploadId;
}

async function rowCount(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

let queueSendSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await resetAndMigrate();
  await clearAttachmentKv();
  await completeSetup();
  queueSendSpy = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
});

afterEach(() => {
  queueSendSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// 1. AC #1 — Compose send without attachments remains unchanged.
// ---------------------------------------------------------------------------

it('R-OUTBOUND-006 + R-API-004: compose without attachments leaves the original send path byte-identical', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();

  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        subject: 'plain',
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-no-attachments-001',
      },
    },
  );

  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.data.status).toBe('queued');

  // No message_attachments row written, no attachment.consumed audit.
  expect(await rowCount('message_attachments')).toBe(0);
  const audits = await env.DB.prepare(
    `SELECT action FROM audit_events WHERE resource_id = ? ORDER BY action`,
  )
    .bind(body.data.messageId)
    .all<{ action: string }>();
  expect((audits.results ?? []).map((a) => a.action)).toEqual(['message.send']);

  // Idempotency record + exactly one queue submission.
  expect(await rowCount('idempotency_records')).toBe(1);
  expect(queueSendSpy).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// 2. AC #2 — Upload then compose with one upload.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-005 + R-ATTACHMENT-006 + R-OUTBOUND-006 + R-AUDIT-001: a single upload produces one attachment row, one consumed transition, one message.send + one attachment.consumed audit, one queue submission', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A, {
    filename: 'report.pdf',
    contentType: 'application/pdf',
  });

  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        subject: 'with attachment',
        attachmentUploadIds: [upload.uploadId],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-single-upload-001',
      },
    },
  );

  expect(response.status).toBe(202);
  const body = await response.json();
  const messageId = body.data.messageId;

  // 1 message_attachments row, fully populated.
  const attach = await env.DB.prepare(
    `SELECT upload_id, message_id, object_key, filename, content_type, size_bytes,
            disposition, sha256
       FROM message_attachments WHERE message_id = ?`,
  )
    .bind(messageId)
    .first<{
      upload_id: string;
      message_id: string;
      object_key: string;
      filename: string;
      content_type: string;
      size_bytes: number;
      disposition: string;
      sha256: string | null;
    }>();
  expect(attach).toEqual({
    upload_id: upload.uploadId,
    message_id: messageId,
    object_key: `attachment:${upload.uploadId}`,
    filename: 'report.pdf',
    content_type: 'application/pdf',
    size_bytes: UPLOAD_BYTES_A.byteLength,
    disposition: 'attachment',
    sha256: null,
  });

  // upload transitioned to consumed with consumed_at set.
  const uploadRow = await env.DB.prepare(
    `SELECT status, consumed_at FROM attachment_uploads WHERE id = ?`,
  )
    .bind(upload.uploadId)
    .first<{ status: string; consumed_at: string | null }>();
  expect(uploadRow?.status).toBe('consumed');
  expect(uploadRow?.consumed_at).not.toBeNull();

  // Exactly one outbound_jobs row + exactly one message.send audit + one
  // attachment.consumed audit. One idempotency row. One queue submission.
  expect(await rowCount('outbound_jobs')).toBe(1);
  expect(await rowCount('idempotency_records')).toBe(1);
  const audits = await env.DB.prepare(
    `SELECT action FROM audit_events ORDER BY created_at, id`,
  ).all<{ action: string }>();
  expect((audits.results ?? []).map((a) => a.action).sort()).toEqual([
    'attachment.consumed',
    'message.send',
  ]);
  expect(queueSendSpy).toHaveBeenCalledTimes(1);

  // KV bytes still present (CAP-051 owns cleanup, not CAP-050).
  const kvBytes = await env.CACHE.get(`attachment:${upload.uploadId}`);
  expect(kvBytes).not.toBeNull();
  const persistent = await env.ATTACHMENTS.get(`attachment:${upload.uploadId}`);
  expect(persistent).not.toBeNull();
  expect(
    Array.from(new Uint8Array((await persistent?.arrayBuffer()) ?? new ArrayBuffer(0))),
  ).toEqual(Array.from(UPLOAD_BYTES_A));
});

// ---------------------------------------------------------------------------
// 3. AC #3 — Multiple attachments, including an inline disposition.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-002 + R-ATTACHMENT-006: multiple attachments including inline disposition each persist a row with the correct disposition', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const attachment = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A, {
    filename: 'evidence.bin',
    contentType: 'application/octet-stream',
    disposition: 'attachment',
  });
  const inline = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_B, {
    filename: 'logo.png',
    contentType: 'image/png',
    disposition: 'inline',
  });

  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        subject: 'two attachments',
        attachmentUploadIds: [attachment.uploadId, inline.uploadId],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-multi-upload-001',
      },
    },
  );

  expect(response.status).toBe(202);
  const body = await response.json();
  const messageId = body.data.messageId;

  const rows = await env.DB.prepare(
    `SELECT upload_id, disposition, filename, content_type
       FROM message_attachments WHERE message_id = ?
    ORDER BY filename ASC`,
  )
    .bind(messageId)
    .all<{ upload_id: string; disposition: string; filename: string; content_type: string }>();
  expect(rows.results).toEqual([
    {
      upload_id: attachment.uploadId,
      disposition: 'attachment',
      filename: 'evidence.bin',
      content_type: 'application/octet-stream',
    },
    {
      upload_id: inline.uploadId,
      disposition: 'inline',
      filename: 'logo.png',
      content_type: 'image/png',
    },
  ]);

  // Two attachment.consumed audit rows.
  const consumedAudits = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'attachment.consumed' AND resource_id IN (?, ?)`,
  )
    .bind(attachment.uploadId, inline.uploadId)
    .first<{ count: number }>();
  expect(consumedAudits?.count).toBe(2);

  // Both uploads consumed.
  const consumed = await env.DB.prepare(
    `SELECT id, status FROM attachment_uploads WHERE id IN (?, ?)`,
  )
    .bind(attachment.uploadId, inline.uploadId)
    .all<{ id: string; status: string }>();
  for (const row of consumed.results ?? []) {
    expect(row.status).toBe('consumed');
  }
});

// ---------------------------------------------------------------------------
// 4. AC #4 — Duplicate upload IDs rejected before writes.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-001 + R-API-005: duplicate upload IDs in the same request are rejected with 400 before any D1 writes', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);

  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        attachmentUploadIds: [upload.uploadId, upload.uploadId],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-dup-upload-001',
      },
    },
  );

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe('VALIDATION_ERROR');

  // No writes at all.
  expect(await rowCount('messages')).toBe(0);
  expect(await rowCount('message_attachments')).toBe(0);
  expect(await rowCount('idempotency_records')).toBe(0);
  expect(await rowCount('audit_events')).toBe(0);
  expect(queueSendSpy).not.toHaveBeenCalled();

  // The upload must remain usable for a future retry.
  const uploadRow = await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
    .bind(upload.uploadId)
    .first<{ status: string }>();
  expect(uploadRow?.status).toBe('uploaded');
});

// ---------------------------------------------------------------------------
// 5. AC #5 — More than 10 IDs rejected before writes.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-002 + R-API-005: more than 10 attachmentUploadIds are rejected with 400 before any D1 writes', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();

  const ids = Array.from({ length: 11 }, () => crypto.randomUUID());

  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        attachmentUploadIds: ids,
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-overflow-001',
      },
    },
  );

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe('VALIDATION_ERROR');

  expect(await rowCount('messages')).toBe(0);
  expect(await rowCount('message_attachments')).toBe(0);
  expect(await rowCount('idempotency_records')).toBe(0);
  expect(queueSendSpy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 6. AC #6 — Missing / foreign / expired / already-consumed / KV-missing
//    uploads collapse to the same stable 400 envelope with no side effects.
// ---------------------------------------------------------------------------

async function expectSafeUnavailable(params: {
  readonly label: string;
  readonly buildUploadIds: (ownerId: string, mailboxId: string) => Promise<readonly string[]>;
  readonly mailboxOwnerId?: string;
}): Promise<void> {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, params.mailboxOwnerId ?? ownerId, 'me');
  await createActiveProviderConnection();
  const ids = await params.buildUploadIds(params.mailboxOwnerId ?? ownerId, mailboxId);

  // Use a unique idempotency key per scenario so each test starts from
  // a clean D1 idempotency_records state.
  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        attachmentUploadIds: ids,
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': `cap-050-unavail-${params.label}-${crypto.randomUUID()}`,
      },
    },
  );

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe('ATTACHMENT_UPLOAD_NOT_FOUND');

  expect(await rowCount('messages')).toBe(0);
  expect(await rowCount('message_attachments')).toBe(0);
  expect(await rowCount('idempotency_records')).toBe(0);
  expect(await rowCount('audit_events')).toBe(0);
  expect(queueSendSpy).not.toHaveBeenCalled();
}

it('R-AUTHZ-004: a missing upload collapses to the same safe envelope (no disclosure)', async () => {
  await expectSafeUnavailable({
    label: 'missing',
    buildUploadIds: async () => [crypto.randomUUID()],
  });
});

it('R-AUTHZ-004: a foreign-owned upload collapses to the same safe envelope', async () => {
  // The actor owns the mailbox (so assertCan passes and we reach the
  // preflight). The upload was staged by a different user — its owner
  // does not match the authenticated actor — so the preflight returns
  // missing and the route surfaces the safe envelope.
  const otherOwner = await createUserWithRole('member', 'other@example.com');
  await expectSafeUnavailable({
    label: 'foreign-owner',
    buildUploadIds: async (_actorId, mailboxId) => {
      const u = await uploadAttachment(mailboxId, otherOwner, UPLOAD_BYTES_A);
      return [u.uploadId];
    },
  });
});

it('R-ATTACHMENT-007 + R-AUTHZ-004: an expired upload collapses to the same safe envelope', async () => {
  await expectSafeUnavailable({
    label: 'expired',
    buildUploadIds: async (ownerId, mailboxId) => {
      const id = await uploadExpired(mailboxId, ownerId, UPLOAD_BYTES_A);
      return [id];
    },
  });
});

it('R-ATTACHMENT-006: an already-consumed upload collapses to the same safe envelope', async () => {
  await expectSafeUnavailable({
    label: 'already-consumed',
    buildUploadIds: async (ownerId, mailboxId) => {
      const id = await uploadConsumed(mailboxId, ownerId, UPLOAD_BYTES_A);
      return [id];
    },
  });
});

it('R-ATTACHMENT-005: a KV-missing upload collapses to the same safe envelope (upload row present, bytes absent)', async () => {
  await expectSafeUnavailable({
    label: 'kv-missing',
    buildUploadIds: async (ownerId, mailboxId) => {
      const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);
      // Wipe the KV bytes after the D1 row was created — simulates TTL
      // expiry / GC between CAP-049 and CAP-050.
      await env.CACHE.delete(`attachment:${upload.uploadId}`);
      return [upload.uploadId];
    },
  });
});

it('R-ATTACHMENT-003 + R-ATTACHMENT-005: a KV-length-mismatched upload collapses to the same safe envelope', async () => {
  await expectSafeUnavailable({
    label: 'kv-mismatch',
    buildUploadIds: async (ownerId, mailboxId) => {
      const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);
      // D1 metadata says 6 bytes; write 5 instead.
      await env.CACHE.put(`attachment:${upload.uploadId}`, new Uint8Array([1, 2, 3, 4, 5]), {
        expirationTtl: 3600,
      });
      return [upload.uploadId];
    },
  });
});

// ---------------------------------------------------------------------------
// 7. AC #7 — Reusing the same upload with a different idempotency key
//    cannot consume it twice.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-006: the same upload consumed by two compose requests (different idempotency keys) only succeeds the first time', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);

  const first = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({
      to: [{ address: 'to@example.com' }],
      attachmentUploadIds: [upload.uploadId],
    }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'cap-050-double-consume-first',
    },
  });
  expect(first.status).toBe(202);

  // Second request with a NEW idempotency key, same upload — must be
  // rejected because the upload is already `consumed` and the preflight
  // refuses to attach a non-`uploaded` row.
  const second = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({
      to: [{ address: 'to@example.com' }],
      attachmentUploadIds: [upload.uploadId],
    }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'cap-050-double-consume-second',
    },
  });
  expect(second.status).toBe(400);
  const body = await second.json();
  expect(body.error.code).toBe('ATTACHMENT_UPLOAD_NOT_FOUND');

  // Exactly one message_attachments row, one outbound job, two idempotency
  // records (the first succeeded, the second never landed — its body
  // never reached the idempotency INSERT because preflight returned first).
  expect(await rowCount('message_attachments')).toBe(1);
  expect(await rowCount('outbound_jobs')).toBe(1);
  expect(await rowCount('idempotency_records')).toBe(1);
  expect(queueSendSpy).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// 8. AC #8 — Concurrent same-idempotency-key compose requests with
//    attachments: one message, one attachment row, one job, one set of
//    audits, one idempotency row, one queue submission; the loser replays.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-006 + R-OUTBOUND-006 + R-AUDIT-001: concurrent same-key requests resolve to one of each; the loser replays', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);

  const body = JSON.stringify({
    to: [{ address: 'to@example.com' }],
    attachmentUploadIds: [upload.uploadId],
  });
  const idempotencyKey = 'cap-050-concurrent-same-key-001';
  const url = `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'Idempotency-Key': idempotencyKey,
  };

  const [a, b] = await Promise.all([
    SELF.fetch(url, { method: 'POST', body, headers }),
    SELF.fetch(url, { method: 'POST', body, headers }),
  ]);

  if (a.status !== 202 || b.status !== 202) {
    expect(`a=${a.status} body=${await a.text()} | b=${b.status} body=${await b.text()}`).toBe(
      'a=202 body= | b=202 body=',
    );
  }

  expect(a.status).toBe(202);
  expect(b.status).toBe(202);

  const aBody = await a.json();
  const bBody = await b.json();
  // Both responses share the SAME messageId — the loser replays.
  expect(aBody.data.messageId).toBe(bBody.data.messageId);

  // Exactly one of each row.
  expect(await rowCount('messages')).toBe(1);
  expect(await rowCount('message_attachments')).toBe(1);
  expect(await rowCount('outbound_jobs')).toBe(1);
  expect(await rowCount('idempotency_records')).toBe(1);
  // One message.send audit + one attachment.consumed audit (NOT two).
  expect(await rowCount('audit_events')).toBe(2);
  const audits = await env.DB.prepare(`SELECT action FROM audit_events ORDER BY action`).all<{
    action: string;
  }>();
  expect((audits.results ?? []).map((row) => row.action)).toEqual([
    'attachment.consumed',
    'message.send',
  ]);
  expect(queueSendSpy).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// 9. AC #9 — Deterministic audit/D1 failure rolls back; no queue call;
//    KV intact.
// ---------------------------------------------------------------------------

it('R-OUTBOUND-006 + R-AUDIT-001: a deterministic D1 failure during the batch rolls back every row; KV bytes survive; queue is never called', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);

  // Sabotage: pre-insert a row with the messageId the route will compute
  // so the messages INSERT hits a UNIQUE/PRIMARY KEY conflict on the
  // *first* statement — guaranteeing the whole batch aborts before any
  // queue submission. We do this by seeding an idempotency_records row
  // at the unique collision boundary instead: simpler is to pre-insert
  // a message row with a colliding ID. Since the route generates the
  // messageId internally, the deterministic conflict is best induced by
  // violating the messages.id PRIMARY KEY — pre-insert a message with
  // the same generated ID. To do that, we wrap the route handler in a
  // spy that returns a deterministic messageId... that's too invasive.
  //
  // Instead we use the idempotency_records unique constraint as the
  // forced failure: a sibling request with the same Idempotency-Key
  // already committed its record. The route's preflight replay branch
  // should catch it before the batch — so this path does NOT trigger a
  // batch failure. Use the UNIQUE on attachment_uploads instead by
  // forcing two uploads with the same id (impossible via the route) —
  // not viable here.
  //
  // The cleanest deterministic D1 failure we can introduce is to seed a
  // row that violates the messages PRIMARY KEY by reserving the row id
  // through pre-inserting a message that owns an outbound_jobs row
  // referencing the messageId the route will compute. Practically the
  // simplest reliable trigger is to inject an unread domain — but the
  // preflight for that is also deterministic on a different path.
  //
  // Use a mailbox_id that the route's assertCan refuses for the actor:
  // we delete the mailbox_members row mid-flight. The route will throw
  // MAILBOX_ACCESS_DENIED BEFORE the batch. That does not exercise the
  // atomic-rollback guarantee we want here.
  //
  // The right approach: poison `users.email` to a value longer than the
  // 254-byte email cap (impossible via API), or shorter still — drop a
  // row into messages with the SAME id the route would generate. We can
  // do that by reading the route's generated id off the idempotency
  // replay. Use a simpler mechanism: send a body whose cc email fails
  // the emailAddressSchema check by overflowing the 254-byte cap.
  // The zod check happens before any D1 write, so that does not exercise
  // batch rollback either.
  //
  // The most realistic D1-induced rollback is to pre-insert a sibling
  // attachment_uploads row with the SAME uploadId, then mutate the D1
  // state in a way the batch will reject. Simplest: pre-stage an audit
  // row whose id collides with the route-generated `auditEventId`. The
  // route generates audit IDs internally — we'd need to know them. We
  // cannot. So instead we engineer the failure through a CHECK
  // constraint violation: insert an outbound_jobs row whose
  // max_attempts is negative (the column has a CHECK > 0). Then
  // prepareCreateOutboundJob will fail the CHECK at INSERT time.
  //
  // Workable approach: pre-insert a row whose presence causes the
  // messages.id UUID to collide — but we don't know that id. The cleanest
  // deterministic failure remains: pre-insert a TRIGGER that always
  // raises when the audit_events table is touched. We attach it now,
  // call the route, then drop the trigger.
  await env.DB.prepare(
    `CREATE TRIGGER IF NOT EXISTS sabotage_audit_abort
       BEFORE INSERT ON audit_events
       FOR EACH ROW
       WHEN NEW.action = 'message.send'
       BEGIN
         SELECT RAISE(ABORT, 'sabotage: audit insert blocked');
       END`,
  ).run();

  try {
    const response = await SELF.fetch(
      `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
      {
        method: 'POST',
        body: JSON.stringify({
          to: [{ address: 'to@example.com' }],
          attachmentUploadIds: [upload.uploadId],
        }),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Idempotency-Key': 'cap-050-d1-rollback-001',
        },
      },
    );

    expect(response.status).toBe(500);
  } finally {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS sabotage_audit_abort`).run();
  }

  // Rollback assertions: message, attachment, audit, job, idempotency all 0.
  expect(await rowCount('messages')).toBe(0);
  expect(await rowCount('message_attachments')).toBe(0);
  expect(await rowCount('outbound_jobs')).toBe(0);
  expect(await rowCount('audit_events')).toBe(0);
  expect(await rowCount('idempotency_records')).toBe(0);

  // Upload still in `uploaded` state, KV bytes still intact.
  const uploadRow = await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
    .bind(upload.uploadId)
    .first<{ status: string }>();
  expect(uploadRow?.status).toBe('uploaded');
  const kvBytes = await env.CACHE.get(`attachment:${upload.uploadId}`, 'arrayBuffer');
  expect(kvBytes).not.toBeNull();
  expect(new Uint8Array(kvBytes as ArrayBuffer)).toEqual(UPLOAD_BYTES_A);

  // No queue submission ever fired.
  expect(queueSendSpy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 10. AC #10 — Queue processing loads the bytes from CACHE and passes the
//     correct provider-neutral payload.
// ---------------------------------------------------------------------------

it('R-OUTBOUND-006 + R-ATTACHMENT-006: processOutboundJob loads binary bytes from CACHE and builds the correct provider-neutral attachments array', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const attachment = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A, {
    filename: 'report.pdf',
    contentType: 'application/pdf',
  });
  const inline = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_B, {
    filename: 'logo.png',
    contentType: 'image/png',
    disposition: 'inline',
  });

  const sendResponse = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        subject: 'queue path',
        attachmentUploadIds: [attachment.uploadId, inline.uploadId],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-queue-payload-001',
      },
    },
  );
  expect(sendResponse.status).toBe(202);
  const sendBody = await sendResponse.json();
  const messageId = sendBody.data.messageId;

  // Spy on adapter.send to capture the provider-neutral payload.
  const captured: Array<unknown> = [];
  const adapter: OutboundProviderAdapter = {
    key: parseProviderKey('brevo'),
    validateConnection: async () => {},
    send: async (_ctx, msg) => {
      captured.push(msg);
      return { providerMessageId: 'fake-provider-id', acceptedAt: '2026-01-01T00:00:00Z' };
    },
  };

  // Pull the jobId the route enqueued.
  expect(queueSendSpy).toHaveBeenCalledTimes(1);
  const enqueued = JSON.parse(queueSendSpy.mock.calls[0]?.[0] as string) as { jobId: string };
  const jobId = enqueued.jobId;

  await processOutboundJob(jobId, {
    db: env.DB,
    encryptionKey: ENCRYPTION_KEY,
    adapter,
    attachmentByteStore: getAttachmentByteStore(env),
  });

  expect(captured).toHaveLength(1);
  const sent = captured[0] as {
    idempotencyKey: string;
    attachments: ReadonlyArray<{
      filename: string;
      contentType: string;
      disposition: 'attachment' | 'inline';
      contentId?: string;
      content: ArrayBuffer;
    }>;
  };
  expect(sent.idempotencyKey).toBe(messageId);
  expect(sent.attachments).toHaveLength(2);

  // Order is by message_attachments.created_at + id — independent of the
  // request's attachmentUploadIds order — so assert by filename.
  const report = sent.attachments.find((a) => a.filename === 'report.pdf');
  const logo = sent.attachments.find((a) => a.filename === 'logo.png');
  expect(report?.contentType).toBe('application/pdf');
  expect(report?.disposition).toBe('attachment');
  expect(report?.contentId).toBeUndefined();
  expect(new Uint8Array(report?.content as ArrayBuffer)).toEqual(UPLOAD_BYTES_A);

  expect(logo?.contentType).toBe('image/png');
  expect(logo?.disposition).toBe('inline');
  expect(logo?.contentId).toBeUndefined();
  expect(new Uint8Array(logo?.content as ArrayBuffer)).toEqual(UPLOAD_BYTES_B);
});

// ---------------------------------------------------------------------------
// 11. AC #11 — Brevo payload encodes each attachment exactly once, with
//     correct filename, MIME type, and base64 content; no raw bytes /
//     secrets leak.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-006 + R-SECRET-003: Brevo encodes each attachment exactly once as base64 with the right filename + MIME type, and never leaks raw bytes or secrets', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A, {
    filename: 'report.pdf',
    contentType: 'application/pdf',
  });

  const sendResponse = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        subject: 'brevo path',
        attachmentUploadIds: [upload.uploadId],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-brevo-payload-001',
      },
    },
  );
  expect(sendResponse.status).toBe(202);

  const jobId = (JSON.parse(queueSendSpy.mock.calls[0]?.[0] as string) as { jobId: string }).jobId;

  // Mock fetch to capture Brevo's outgoing request body without hitting
  // the network. The real Brevo adapter constructs the JSON payload from
  // provider-neutral fields, so we need it to drive the assertion.
  const sentBodies: string[] = [];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    sentBodies.push(bodyText);
    return new Response(JSON.stringify({ messageId: 'brevo-msg-1' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    await processOutboundJob(jobId, {
      db: env.DB,
      encryptionKey: ENCRYPTION_KEY,
      adapter: brevoAdapter,
      attachmentByteStore: getAttachmentByteStore(env),
    });
  } finally {
    fetchMock.mockRestore();
  }

  expect(sentBodies).toHaveLength(1);
  const sentBody = sentBodies[0];
  if (!sentBody) {
    throw new Error('expected one captured outbound body');
  }
  const body = JSON.parse(sentBody) as {
    attachment?: ReadonlyArray<{ name?: string; content?: string; contentType?: string }>;
  };
  expect(body.attachment).toHaveLength(1);
  const attachment = body.attachment?.[0];
  expect(attachment?.name).toBe('report.pdf');
  expect(attachment?.contentType).toBe('application/pdf');
  // Base64 round-trip: decoded bytes must equal the staged bytes.
  const decoded = new Uint8Array(Buffer.from(attachment?.content ?? '', 'base64'));
  expect(decoded).toEqual(UPLOAD_BYTES_A);

  // The raw bytes must NOT appear in the JSON body (no base64-then-JSON
  // re-encoding leaks). A 6-byte payload hex-encoded is 12 chars; if it
  // appeared as a literal substring the test would catch it.
  expect(sentBody).not.toContain(Array.from(UPLOAD_BYTES_A).join(','));
  // No API key or credential plaintext leaks into the body.
  expect(sentBodies[0]).not.toContain('test-brevo-api-key');
  // Encoded exactly once — the base64 length is exactly what one
  // base64-encode of the 6-byte input yields (8 chars + 1 padding? no,
  // 6 bytes -> ceil(6/3)*4 = 8 chars).
  expect(attachment?.content?.length).toBe(8);
});

// ---------------------------------------------------------------------------
// 12. AC #12 — Authz/IDOR tests for the new attachmentUploadIds field.
// ---------------------------------------------------------------------------

it('R-AUTHZ-003 + R-AUTHZ-004: a non-member cannot send with attachments from another user’s mailbox', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const intruderId = await createUserWithRole('member', 'intruder@example.com');
  const intruderToken = await createSession(intruderId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'private');
  await createActiveProviderConnection();

  const response = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        attachmentUploadIds: [crypto.randomUUID()],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${intruderToken}`,
        'Idempotency-Key': 'cap-050-idor-001',
      },
    },
  );

  expect(response.status).toBe(403);
  const body = await response.json();
  expect(body.error.code).toBe('MAILBOX_ACCESS_DENIED');
  expect(await rowCount('messages')).toBe(0);
  expect(queueSendSpy).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// 13. AC #13 — A consumed-relation message cannot be inserted twice even
//     via direct SQL — verifies the UNIQUE index is doing its job.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-006: the message_attachments_upload_unique UNIQUE index rejects a direct second INSERT with the same upload_id', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);

  const sendResponse = await SELF.fetch(
    `http://localhost/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        attachmentUploadIds: [upload.uploadId],
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': 'cap-050-unique-index-001',
      },
    },
  );
  expect(sendResponse.status).toBe(202);
  const messageId = (await sendResponse.json()).data.messageId;

  // Attempt a second INSERT with the same upload_id directly. The
  // BEFORE INSERT trigger will refuse it because status is no longer
  // 'uploaded', but the UNIQUE index is the schema-layer guard. Either
  // path produces a hard error.
  await expect(
    env.DB.prepare(
      `INSERT INTO message_attachments (
         id, message_id, upload_id, object_key, filename, content_type,
         size_bytes, disposition, content_id, sha256, created_at
       ) VALUES (?, ?, ?, ?, 'x', 'application/octet-stream', 1, 'attachment', NULL, NULL, datetime('now'))`,
    )
      .bind(crypto.randomUUID(), messageId, upload.uploadId, `attachment:${upload.uploadId}`)
      .run(),
  ).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// 14. R-AUTHZ-004 + R-ATTACHMENT-001 + R-DATA-005 — the BEFORE INSERT
//     trigger must reject an attach that links user A's upload to a
//     message created by user B. The route's preflight already refuses
//     this at the application layer; this test exercises the schema-layer
//     guarantee that survives a future preflight regression.
//
//     The attack: user B (the message creator) references an upload row
//     owned by user A. Every canonical metadata field matches the
//     upload row, status is 'uploaded', expiry is in the future — the
//     only difference is ownership. The trigger's JOIN against
//     `messages.created_by_user_id` is the only line of defence, and
//     it must fire RAISE(ABORT, 'ATTACHMENT_UPLOAD_NOT_CONSUMABLE').
//
//     Because we never go through the compose route, no queue send,
//     audit row, or idempotency record is even possible. Asserting
//     those tables stay empty is the "no side effects" proof.
// ---------------------------------------------------------------------------

it('R-AUTHZ-004 + R-ATTACHMENT-001: the trigger rejects a cross-owner attach with ATTACHMENT_UPLOAD_NOT_CONSUMABLE; no side effects', async () => {
  // User A owns the upload. User B will own the message. Both are real
  // member-role accounts so the global permission check is irrelevant
  // here (we never call the route).
  const attackerId = await createUserWithRole('member', 'attacker@example.com');
  const victimId = await createUserWithRole('member', 'victim@example.com');
  const domainId = await createDomain();
  const attackerMailboxId = await createMailbox(domainId, attackerId, 'attacker');
  const upload = await uploadAttachment(attackerMailboxId, attackerId, UPLOAD_BYTES_A, {
    filename: 'secret.bin',
    contentType: 'application/octet-stream',
  });

  // User B creates their own message directly in D1 (bypassing the
  // compose route, which would refuse the cross-owner upload at the
  // preflight). created_by_user_id = victimId is what the trigger
  // compares against attachment_uploads.owner_user_id.
  const messageId = crypto.randomUUID();
  const t = now().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(
    `INSERT INTO messages (
       id, from_address, from_name, subject, html_body, text_body,
       message_id_header, in_reply_to_header, references_header,
       status, created_by_user_id, created_at, updated_at
     ) VALUES (?, 'victim@victim.example.com', '', 'cross-owner probe', '', '', NULL, NULL, '', 'queued', ?, ?, ?)`,
  )
    .bind(messageId, victimId, t, t)
    .run();

  // The direct INSERT — every canonical field matches the upload row,
  // except for the ownership join. The trigger's
  // `au.owner_user_id = m.created_by_user_id` predicate cannot hold.
  const violationInsert = env.DB.prepare(
    `INSERT INTO message_attachments (
       id, message_id, upload_id, object_key, filename, content_type,
       size_bytes, disposition, content_id, sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
  ).bind(
    crypto.randomUUID(),
    messageId,
    upload.uploadId,
    `attachment:${upload.uploadId}`,
    upload.filename,
    upload.contentType,
    upload.sizeBytes,
    upload.disposition,
  );

  await expect(violationInsert.run()).rejects.toThrow(/ATTACHMENT_UPLOAD_NOT_CONSUMABLE/);

  // message_attachments is unchanged — the trigger aborts the INSERT
  // before any row lands.
  expect(await rowCount('message_attachments')).toBe(0);

  // attachment_uploads is still 'uploaded' — no consume UPDATE fired
  // (we never reached the consume statement, because the trigger
  // aborted the earlier INSERT and D1 rolled back the whole batch).
  const uploadRow = await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
    .bind(upload.uploadId)
    .first<{ status: string }>();
  expect(uploadRow?.status).toBe('uploaded');

  // KV bytes are intact — CAP-051 owns the eventual cleanup.
  const kvBytes = await env.CACHE.get(`attachment:${upload.uploadId}`, 'arrayBuffer');
  expect(kvBytes).not.toBeNull();
  expect(new Uint8Array(kvBytes as ArrayBuffer)).toEqual(UPLOAD_BYTES_A);

  // No queue submission, no audit row, no idempotency record — none of
  // those tables ever saw a write.
  expect(queueSendSpy).not.toHaveBeenCalled();
  expect(await rowCount('audit_events')).toBe(0);
  expect(await rowCount('idempotency_records')).toBe(0);
});

// ---------------------------------------------------------------------------
// 15. R-ATTACHMENT-006 — the UNIQUE(upload_id) index is the second
//     schema-layer guard. Unlike test #13 (which relies on the trigger
//     firing first because the upload is already consumed), this test
//     keeps the upload in 'uploaded' state and constructs two
//     message_attachments rows that BOTH satisfy the trigger
//     preconditions. The only thing standing between the second INSERT
//     and the table is the UNIQUE index — and the whole batch must
//     roll back, leaving zero rows in message_attachments.
//
//     Because the batch is atomic, the first INSERT also rolls back
//     when the second one fails (R-OUTBOUND-006 / R-ATTACHMENT-006
//     atomicity). That is the property the route relies on for the
//     concurrent same-key consume race.
// ---------------------------------------------------------------------------

it('R-ATTACHMENT-006: two message_attachments INSERTs with the same upload_id in one batch fail on the UNIQUE constraint and leave zero rows', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  const upload = await uploadAttachment(mailboxId, ownerId, UPLOAD_BYTES_A);

  // Two independent messages owned by the same user (so the trigger's
  // ownership join is satisfied for both rows). Both rows carry the
  // canonical metadata that matches the upload row.
  const messageA = crypto.randomUUID();
  const messageB = crypto.randomUUID();
  const t = now().slice(0, 19).replace('T', ' ');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (
         id, from_address, from_name, subject, html_body, text_body,
         message_id_header, in_reply_to_header, references_header,
         status, created_by_user_id, created_at, updated_at
       ) VALUES (?, 'me@example.com', '', 'a', '', '', NULL, NULL, '', 'queued', ?, ?, ?)`,
    ).bind(messageA, ownerId, t, t),
    env.DB.prepare(
      `INSERT INTO messages (
         id, from_address, from_name, subject, html_body, text_body,
         message_id_header, in_reply_to_header, references_header,
         status, created_by_user_id, created_at, updated_at
       ) VALUES (?, 'me@example.com', '', 'b', '', '', NULL, NULL, '', 'queued', ?, ?, ?)`,
    ).bind(messageB, ownerId, t, t),
  ]);

  // Both INSERTs satisfy the trigger: same owner, status='uploaded',
  // not expired, canonical metadata matches. The second INSERT will
  // collide on the UNIQUE(upload_id) index.
  await expect(
    env.DB.batch([
      env.DB.prepare(
        `INSERT INTO message_attachments (
           id, message_id, upload_id, object_key, filename, content_type,
           size_bytes, disposition, content_id, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
      ).bind(
        crypto.randomUUID(),
        messageA,
        upload.uploadId,
        `attachment:${upload.uploadId}`,
        upload.filename,
        upload.contentType,
        upload.sizeBytes,
        upload.disposition,
      ),
      env.DB.prepare(
        `INSERT INTO message_attachments (
           id, message_id, upload_id, object_key, filename, content_type,
           size_bytes, disposition, content_id, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, datetime('now'))`,
      ).bind(
        crypto.randomUUID(),
        messageB,
        upload.uploadId,
        `attachment:${upload.uploadId}`,
        upload.filename,
        upload.contentType,
        upload.sizeBytes,
        upload.disposition,
      ),
    ]),
  ).rejects.toThrow(/UNIQUE constraint failed.*message_attachments/);

  // The batch rolled back. Neither row landed.
  expect(await rowCount('message_attachments')).toBe(0);

  // The upload is still 'uploaded' — the consume UPDATE was never
  // reached (and even if it had been, the atomic batch would have
  // rolled it back too).
  const uploadRow = await env.DB.prepare(`SELECT status FROM attachment_uploads WHERE id = ?`)
    .bind(upload.uploadId)
    .first<{ status: string }>();
  expect(uploadRow?.status).toBe('uploaded');

  // The two messages we created above still exist — D1 only rolled
  // back the failed batch, not the earlier (succeeded) batch.
  expect(await rowCount('messages')).toBe(2);
});

it('R-OUTBOUND-006: over 10 MB converts every legacy attachment, including tiny files, to a final R2 list and replays without duplication', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const sizes = [5 * 1024 * 1024, 3 * 1024 * 1024, 3];
  const uploads = [];
  for (const [index, size] of sizes.entries())
    uploads.push(
      await uploadAttachment(mailboxId, ownerId, new Uint8Array(size).fill(index + 1), {
        filename: `file-${index}.bin`,
      }),
    );
  const url = `https://example.com/api/v1/mailboxes/${mailboxId}/messages/send`;
  const init = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'large-mail-001',
    },
    body: JSON.stringify({
      to: [{ address: 'to@example.com' }],
      subject: 'Large mail',
      htmlBody: '<p>Body</p>',
      textBody: 'Body',
      attachmentUploadIds: uploads.map((x) => x.uploadId),
    }),
  };
  const response = await SELF.fetch(url, init);
  expect(response.status, await response.clone().text()).toBe(202);
  const result = await response.json<{ data: { messageId: string } }>();
  const replay = await SELF.fetch(url, init);
  expect(await replay.json()).toEqual(result);
  expect(await rowCount('editor_assets')).toBe(3);
  expect(await rowCount('editor_asset_usages')).toBe(3);
  const message = await env.DB.prepare('SELECT html_body,text_body FROM messages WHERE id=?')
    .bind(result.data.messageId)
    .first<{ html_body: string; text_body: string }>();
  if (!message) throw new Error('Missing stored message');
  expect(message.html_body).toContain('附件列表（超大附件）');
  const links = [...message.html_body.matchAll(/href="([^"]+)"/g)].map((x) => x[1] ?? '');
  expect(links).toHaveLength(3);
  for (const link of links) {
    const download = await SELF.fetch(link);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Disposition')).toContain('attachment;');
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(sizes).toContain(bytes.byteLength);
    expect(bytes[0]).toBe(sizes.indexOf(bytes.byteLength) + 1);
    expect(message?.text_body).toContain(link);
  }
  const sent: SendProviderMessage[] = [];
  const job = JSON.parse(queueSendSpy.mock.calls[0]?.[0] as string) as { jobId: string };
  await processOutboundJob(job.jobId, {
    db: env.DB,
    encryptionKey: ENCRYPTION_KEY,
    attachmentByteStore: getAttachmentByteStore(env),
    attachmentObjectStore: getAttachmentObjectStore(env),
    adapter: {
      key: parseProviderKey('brevo'),
      validateConnection: async () => {},
      send: async (_ctx, msg) => {
        sent.push(msg);
        return { providerMessageId: 'large-mail-id', acceptedAt: '2026-10-07T00:00:00Z' };
      },
    },
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.attachments).toEqual([]);
  expect(queueSendSpy).toHaveBeenCalledTimes(1);
});

it('R-OUTBOUND-006: mixed editor and legacy attachments all move after the signature when their encoded total exceeds 10 MB', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  await env.DB.prepare(
    "INSERT INTO domain_signatures (id,domain_id,html_content,text_content,is_enabled) VALUES (?,?,'<p>Signature</p>','Signature',1)",
  )
    .bind(crypto.randomUUID(), domainId)
    .run();
  const editorResponse = await SELF.fetch(
    `https://example.com/api/v1/mailboxes/${mailboxId}/editor-assets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
        'X-Filename': 'editor.bin',
        'X-Asset-Kind': 'file',
        'X-File-Size': String(8 * 1024 * 1024),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(8 * 1024 * 1024),
    },
  );
  expect(editorResponse.status).toBe(201);
  const { data: file } = await editorResponse.json<{ data: EditorAssetDescriptor }>();
  const legacy = await uploadAttachment(mailboxId, ownerId, new Uint8Array([1]), {
    filename: 'tiny.bin',
  });
  const response = await SELF.fetch(
    `https://example.com/api/v1/mailboxes/${mailboxId}/messages/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: [{ address: 'to@example.com' }],
        subject: 'Mixed',
        htmlBody: `<p><a href="${file.url}">editor.bin</a></p><p>Body</p>`,
        textBody: `editor.bin\neditor.bin: ${file.url}\nBody`,
        attachmentUploadIds: [legacy.uploadId],
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(202);
  const { data } = await response.json<{ data: { messageId: string } }>();
  const message = await env.DB.prepare('SELECT html_body,text_body FROM messages WHERE id=?')
    .bind(data.messageId)
    .first<{ html_body: string; text_body: string }>();
  if (!message) throw new Error('Missing stored message');
  expect(message.html_body.indexOf(file.url)).toBeGreaterThan(
    message.html_body.indexOf('Signature'),
  );
  expect(message.text_body.indexOf(file.url)).toBeGreaterThan(
    message.text_body.indexOf('Signature'),
  );
  expect(message.html_body.split(file.url)).toHaveLength(2);
  expect(message.html_body).toContain('tiny.bin');
  expect(message.html_body).toContain('附件列表（超大附件）');
});

it('R-OUTBOUND-006: final attachment-list bytes are included at the 10 MB boundary', async () => {
  const ownerId = await createUserWithRole('member', 'owner@example.com');
  const token = await createSession(ownerId);
  const domainId = await createDomain();
  const mailboxId = await createMailbox(domainId, ownerId, 'me');
  await createActiveProviderConnection();
  const response = await SELF.fetch(
    `https://example.com/api/v1/mailboxes/${mailboxId}/editor-assets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
        'X-Filename': 'tiny.bin',
        'X-Asset-Kind': 'file',
        'X-File-Size': '1',
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array([1]),
    },
  );
  expect(response.status).toBe(201);
  const { data: file } = await response.json<{ data: EditorAssetDescriptor }>();
  const html = `<p><a href="${file.url}">tiny.bin</a></p><p>End</p>`;
  const text = `tiny.bin: ${file.url}\nEnd`;
  const firstSize = 5 * 1024 * 1024;
  const estimate = (secondSize: number) =>
    estimateEmailBytes(html, text, 'Boundary', [firstSize, secondSize, 1]);
  let secondSize = Math.floor(
    (OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES - estimate(1)) / ((4 / 3) * 1.04),
  );
  while (estimate(secondSize) > OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES) secondSize--;
  while (estimate(secondSize + 1) <= OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES) secondSize++;
  expect(estimate(secondSize)).toBeLessThanOrEqual(OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES);
  const first = await uploadAttachment(mailboxId, ownerId, new Uint8Array(firstSize), {
    filename: 'first.bin',
  });
  const second = await uploadAttachment(mailboxId, ownerId, new Uint8Array(secondSize), {
    filename: 'second.bin',
  });
  const sent = await SELF.fetch(`https://example.com/api/v1/mailboxes/${mailboxId}/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: [{ address: 'to@example.com' }],
      subject: 'Boundary',
      htmlBody: html,
      textBody: text,
      attachmentUploadIds: [first.uploadId, second.uploadId],
    }),
  });
  expect(sent.status, await sent.clone().text()).toBe(202);
  const { data } = await sent.json<{ data: { messageId: string } }>();
  const message = await env.DB.prepare('SELECT html_body FROM messages WHERE id=?')
    .bind(data.messageId)
    .first<{ html_body: string }>();
  expect(message?.html_body).toContain('附件列表（超大附件）');
  expect(await rowCount('editor_assets')).toBe(3);
});
