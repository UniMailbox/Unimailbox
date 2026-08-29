// CAP-049 Worker-pool acceptance tests for raw attachment staging.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_DISPOSITION_HEADER,
  ATTACHMENT_UPLOAD_MAX_BYTES,
  attachmentUploadDescriptorSchema,
} from '@unimailbox/contracts';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../src/platform/crypto';
import { attachmentUploadOperation } from '../src/modules/attachments';
import { uploadAttachment } from '../src/modules/attachments';
import { createAuditEventWriter } from '../src/modules/admin';
import { getAttachmentByteStore } from '../src/platform/cache';

const UPLOAD_BYTES = new Uint8Array([0, 255, 1, 254, 2, 253]);

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
       VALUES ('message.send', 'message.send', 'Send messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at)
       VALUES ('message.read', 'message.read', 'Read messages', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('sender-role', 'sender-role', 'Sender', 0, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at)
       VALUES ('reader-role', 'reader-role', 'Reader', 0, datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('sender-role', 'message.send', datetime('now'))`,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at)
       VALUES ('reader-role', 'message.read', datetime('now'))`,
    ),
  ]);
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function createUser(roleId: 'sender-role' | 'reader-role', email: string): Promise<string> {
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
      roleId,
      now,
    ),
  ]);
  return userId;
}

async function createSession(userId: string): Promise<string> {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      await hashToken(refreshToken),
      Math.floor(Date.now() / 1000) + 86_400,
      new Date().toISOString(),
    )
    .run();
  await env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId }), {
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

async function addMailboxMember(
  mailboxId: string,
  userId: string,
  role: 'viewer' | 'sender',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(mailboxId, userId, role, new Date().toISOString())
    .run();
}

function uploadRequest(
  mailboxId: string,
  accessToken: string,
  idempotencyKey: string,
  body: BodyInit,
  options: {
    readonly filename?: string;
    readonly contentType?: string;
    readonly contentLength?: number;
    readonly disposition?: 'attachment' | 'inline';
    readonly omitFilename?: boolean;
    readonly omitContentType?: boolean;
    readonly omitIdempotencyKey?: boolean;
  } = {},
): Request {
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  if (!options.omitIdempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  if (!options.omitFilename) {
    headers.set(ATTACHMENT_FILENAME_HEADER, options.filename ?? 'evidence.bin');
  }
  if (!options.omitContentType) {
    headers.set('Content-Type', options.contentType ?? 'application/octet-stream');
  }
  if (options.disposition) {
    headers.set(ATTACHMENT_DISPOSITION_HEADER, options.disposition);
  }
  if (options.contentLength !== undefined) {
    headers.set('Content-Length', String(options.contentLength));
  }
  return new Request(`http://localhost/api/v1/mailboxes/${mailboxId}/attachments/uploads`, {
    method: 'POST',
    headers,
    body,
  });
}

async function countRows(table: 'attachment_uploads' | 'idempotency_records'): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

async function attachmentKvKeys(): Promise<string[]> {
  const page = await env.CACHE.list({ prefix: 'attachment:' });
  return page.keys.map((key) => key.name).sort();
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetAndMigrate();
  await clearAttachmentKv();
  await completeSetup();
});

describe('POST /api/v1/mailboxes/:mailboxId/attachments/uploads', () => {
  it('R-ATTACHMENT-001/003/005/007 + R-AUDIT-001 store bytes, metadata, TTL, and audit', async () => {
    const userId = await createUser('sender-role', 'owner@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);

    const response = await SELF.fetch(
      uploadRequest(mailboxId, token, 'attachment-happy-001', UPLOAD_BYTES),
    );
    const responseText = await response.text();
    const envelope = JSON.parse(responseText) as { data: unknown };
    const descriptor = attachmentUploadDescriptorSchema.parse(envelope.data);

    expect(response.status).toBe(201);
    expect(descriptor).toMatchObject({
      mailboxId,
      filename: 'evidence.bin',
      contentType: 'application/octet-stream',
      disposition: 'attachment',
      sizeBytes: UPLOAD_BYTES.byteLength,
      status: 'uploaded',
    });
    expect(responseText).not.toContain('255');

    const row = await env.DB.prepare(
      `SELECT owner_user_id, mailbox_id, kv_key, filename, content_type,
              disposition, size_bytes, status, consumed_at,
              CAST(strftime('%s', expires_at) AS INTEGER) -
              CAST(strftime('%s', created_at) AS INTEGER) AS ttl_seconds
       FROM attachment_uploads WHERE id = ?`,
    )
      .bind(descriptor.uploadId)
      .first<{
        owner_user_id: string;
        mailbox_id: string;
        kv_key: string;
        filename: string;
        content_type: string;
        disposition: string;
        size_bytes: number;
        status: string;
        consumed_at: string | null;
        ttl_seconds: number;
      }>();
    expect(row).toEqual({
      owner_user_id: userId,
      mailbox_id: mailboxId,
      kv_key: `attachment:${descriptor.uploadId}`,
      filename: 'evidence.bin',
      content_type: 'application/octet-stream',
      disposition: 'attachment',
      size_bytes: UPLOAD_BYTES.byteLength,
      status: 'uploaded',
      consumed_at: null,
      ttl_seconds: 3600,
    });
    const stored = await env.CACHE.get(`attachment:${descriptor.uploadId}`, 'arrayBuffer');
    expect(Array.from(new Uint8Array(stored ?? new ArrayBuffer(0)))).toEqual(
      Array.from(UPLOAD_BYTES),
    );
    const listed = await env.CACHE.list({ prefix: `attachment:${descriptor.uploadId}` });
    const listedKey = listed.keys.find((key) => key.name === `attachment:${descriptor.uploadId}`);
    expect(listedKey).toBeDefined();
    if (!listedKey || listedKey.expiration === undefined) {
      throw new Error('Attachment KV key expiration metadata is missing');
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(listedKey.expiration).toBeGreaterThanOrEqual(nowSeconds + 3590);
    expect(listedKey.expiration).toBeLessThanOrEqual(nowSeconds + 3610);

    const audit = await env.DB.prepare(
      `SELECT actor_user_id, action, resource_type, resource_id, request_id, metadata
       FROM audit_events WHERE action = 'attachment.uploaded'`,
    ).first<{
      actor_user_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      request_id: string;
      metadata: string | null;
    }>();
    expect(audit).toMatchObject({
      actor_user_id: userId,
      action: 'attachment.uploaded',
      resource_type: 'attachment_upload',
      resource_id: descriptor.uploadId,
      metadata: null,
    });
    expect(audit?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('R-ATTACHMENT-003/R-API-005 enforce the exact 5 MiB boundary', async () => {
    const userId = await createUser('sender-role', 'limits@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const exact = new Uint8Array(ATTACHMENT_UPLOAD_MAX_BYTES);

    const exactRequest = uploadRequest(mailboxId, token, 'attachment-limit-exact', exact);
    expect(exactRequest.headers.has('Content-Length')).toBe(false);
    expect((await SELF.fetch(exactRequest)).status).toBe(201);

    const over = new Uint8Array(ATTACHMENT_UPLOAD_MAX_BYTES + 1);
    const advertised = await SELF.fetch(
      uploadRequest(mailboxId, token, 'attachment-limit-declared', over, {
        contentLength: over.byteLength,
      }),
    );
    expect(advertised.status).toBe(413);

    const actualRequest = uploadRequest(mailboxId, token, 'attachment-limit-actual', over);
    expect(actualRequest.headers.has('Content-Length')).toBe(false);
    const actual = await SELF.fetch(actualRequest);
    expect(actual.status).toBe(413);
    expect((await actual.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'BODY_TOO_LARGE' },
    });

    expect(await countRows('attachment_uploads')).toBe(1);
    expect(await attachmentKvKeys()).toHaveLength(1);
  });

  it('R-API-005 rejects a streamed body immediately over 5 MiB', async () => {
    const userId = await createUser('sender-role', 'stream-limit@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(ATTACHMENT_UPLOAD_MAX_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const request = uploadRequest(mailboxId, token, 'attachment-stream-over', stream);

    const response = await SELF.fetch(request);

    expect(response.status).toBe(413);
    expect(await countRows('attachment_uploads')).toBe(0);
    expect(await attachmentKvKeys()).toEqual([]);
  });

  it('R-API-004 rejects invalid metadata, empty bodies, and missing idempotency before writes', async () => {
    const userId = await createUser('sender-role', 'invalid@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const cases = [
      uploadRequest(mailboxId, token, 'attachment-no-filename', UPLOAD_BYTES, {
        omitFilename: true,
      }),
      uploadRequest(mailboxId, token, 'attachment-bad-filename', UPLOAD_BYTES, {
        filename: '   ',
      }),
      uploadRequest(mailboxId, token, 'attachment-no-content', UPLOAD_BYTES, {
        omitContentType: true,
      }),
      uploadRequest(mailboxId, token, 'attachment-bad-content', UPLOAD_BYTES, {
        contentType: 'not-a-media-type',
      }),
      uploadRequest(mailboxId, token, 'attachment-empty-body', new Uint8Array()),
      uploadRequest(mailboxId, token, 'ignored-key', UPLOAD_BYTES, {
        omitIdempotencyKey: true,
      }),
    ];

    for (const request of cases) {
      expect((await SELF.fetch(request)).status).toBe(400);
    }
    expect(await countRows('attachment_uploads')).toBe(0);
    expect(await countRows('idempotency_records')).toBe(0);
    expect(await attachmentKvKeys()).toEqual([]);
  });

  it('R-LOG-001/R-SECRET-003 never logs attachment bytes, filename, or key', async () => {
    const userId = await createUser('sender-role', 'logging@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const logSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ];
    const secretFilename = 'password-reset-token-secret.bin';
    const secretKey = 'attachment-secret-key';
    const response = await SELF.fetch(
      uploadRequest(mailboxId, token, secretKey, new Uint8Array([11, 22, 33]), {
        filename: secretFilename,
      }),
    );

    expect(response.status).toBe(201);
    for (const spy of logSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('R-AUTHZ-003/R-AUTHZ-004 deny unauthorized mailbox uploads without writes', async () => {
    const ownerId = await createUser('sender-role', 'mailbox-owner@example.com');
    const mailboxId = await createMailbox(ownerId);
    const readerId = await createUser('reader-role', 'reader@example.com');
    const readerToken = await createSession(readerId);
    const viewerId = await createUser('sender-role', 'viewer@example.com');
    const viewerToken = await createSession(viewerId);
    await addMailboxMember(mailboxId, viewerId, 'viewer');
    const strangerId = await createUser('sender-role', 'stranger@example.com');
    const strangerToken = await createSession(strangerId);

    const globalDenied = await SELF.fetch(
      uploadRequest(mailboxId, readerToken, 'attachment-global-deny', UPLOAD_BYTES),
    );
    const mailboxDenied = await SELF.fetch(
      uploadRequest(mailboxId, viewerToken, 'attachment-mailbox-deny', UPLOAD_BYTES),
    );
    const strangerDenied = await SELF.fetch(
      uploadRequest(mailboxId, strangerToken, 'attachment-stranger', UPLOAD_BYTES),
    );
    const missing = await SELF.fetch(
      uploadRequest(crypto.randomUUID(), strangerToken, 'attachment-missing', UPLOAD_BYTES),
    );

    expect(globalDenied.status).toBe(403);
    expect(mailboxDenied.status).toBe(404);
    expect((await mailboxDenied.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'MAILBOX_NOT_FOUND' },
    });
    expect(strangerDenied.status).toBe(404);
    expect((await strangerDenied.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'MAILBOX_NOT_FOUND' },
    });
    expect(missing.status).toBe(404);
    expect(await countRows('attachment_uploads')).toBe(0);
    expect(await countRows('idempotency_records')).toBe(0);
    expect(await attachmentKvKeys()).toEqual([]);
  });

  it('R-API-004 replays identically, rejects collisions, and scopes keys by mailbox', async () => {
    const userId = await createUser('sender-role', 'replay@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId, 'first');
    const otherMailboxId = await createMailbox(userId, 'second');
    const key = 'attachment-replay-shared';

    const first = await SELF.fetch(uploadRequest(mailboxId, token, key, UPLOAD_BYTES));
    const firstText = await first.text();
    const replay = await SELF.fetch(uploadRequest(mailboxId, token, key, UPLOAD_BYTES));
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(await countRows('attachment_uploads')).toBe(1);
    expect(await attachmentKvKeys()).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.uploaded'`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const changedBytes = await SELF.fetch(
      uploadRequest(mailboxId, token, key, new Uint8Array([9, 8, 7])),
    );
    expect(changedBytes.status).toBe(409);
    expect((await changedBytes.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });

    const changedMetadata = await SELF.fetch(
      uploadRequest(mailboxId, token, key, UPLOAD_BYTES, { filename: 'other.bin' }),
    );
    expect(changedMetadata.status).toBe(409);

    const changedDisposition = await SELF.fetch(
      uploadRequest(mailboxId, token, key, UPLOAD_BYTES, { disposition: 'inline' }),
    );
    expect(changedDisposition.status).toBe(409);

    const otherMailbox = await SELF.fetch(uploadRequest(otherMailboxId, token, key, UPLOAD_BYTES));
    expect(otherMailbox.status).toBe(201);
    expect(await countRows('attachment_uploads')).toBe(2);
    const operations = await env.DB.prepare(
      `SELECT operation FROM idempotency_records WHERE actor_id = ? ORDER BY operation`,
    )
      .bind(userId)
      .all<{ operation: string }>();
    expect(operations.results.map((row) => row.operation)).toEqual(
      [attachmentUploadOperation(mailboxId), attachmentUploadOperation(otherMailboxId)].sort(),
    );
  });

  it('R-API-004 concurrent same-key uploads settle with one KV value and one audit', async () => {
    const userId = await createUser('sender-role', 'concurrent@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const key = 'attachment-concurrent';
    const firstRequest = uploadRequest(mailboxId, token, key, new Uint8Array([4, 5, 6]));
    const secondRequest = uploadRequest(mailboxId, token, key, new Uint8Array([4, 5, 6]));

    const responses = await Promise.all([SELF.fetch(firstRequest), SELF.fetch(secondRequest)]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const responseBodies = await Promise.all(responses.map((response) => response.text()));
    expect(responseBodies[0]).toBe(responseBodies[1]);
    expect(await countRows('attachment_uploads')).toBe(1);
    expect(await countRows('idempotency_records')).toBe(1);
    expect(await attachmentKvKeys()).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.uploaded'`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('R-API-004 concurrent same-key different bytes leaves one winner and one KV value', async () => {
    const userId = await createUser('sender-role', 'concurrent-collision@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const key = 'attachment-concurrent-collision';
    const firstRequest = uploadRequest(mailboxId, token, key, new Uint8Array([7, 8, 9]));
    const secondRequest = uploadRequest(mailboxId, token, key, new Uint8Array([9, 8, 7]));

    const responses = await Promise.all([SELF.fetch(firstRequest), SELF.fetch(secondRequest)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await countRows('attachment_uploads')).toBe(1);
    expect(await countRows('idempotency_records')).toBe(1);
    expect(await attachmentKvKeys()).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.uploaded'`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('R-DATA-004/R-AUDIT-001 clean up bytes when the D1 batch fails', async () => {
    const userId = await createUser('sender-role', 'cleanup@example.com');
    const token = await createSession(userId);
    const mailboxId = await createMailbox(userId);
    const idempotencyKey = 'attachment-d1-failure';
    // Real D1 trigger, not a mock: validation/auth/idempotency all pass, KV.put
    // runs, then the first statement in the D1 batch aborts deterministically.
    await env.DB.prepare(
      `CREATE TRIGGER cap049_abort_attachment_insert
       BEFORE INSERT ON attachment_uploads
       BEGIN
         SELECT RAISE(ABORT, 'cap049 deterministic attachment insert failure');
       END`,
    ).run();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await SELF.fetch(
      uploadRequest(mailboxId, token, idempotencyKey, UPLOAD_BYTES),
    );

    expect(response.status).toBe(500);
    expect(await countRows('attachment_uploads')).toBe(0);
    expect(await countRows('idempotency_records')).toBe(0);
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events WHERE action = 'attachment.uploaded'`,
        ).first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(await attachmentKvKeys()).toEqual([]);
    errorSpy.mockRestore();
  });

  it('R-DATA-004 preserves bytes when commit state is observed after failure', async () => {
    const userId = await createUser('sender-role', 'preserve@example.com');
    const mailboxId = await createMailbox(userId);
    const uploadId = crypto.randomUUID();
    const idempotencyId = crypto.randomUUID();
    const kvKey = `attachment:${uploadId}`;
    const now = '2026-08-28 00:00:00';
    await env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, owner_user_id, mailbox_id, kv_key, filename, content_type,
         disposition, size_bytes, status, expires_at, consumed_at, created_at
       ) VALUES (?, ?, ?, ?, 'existing.bin', 'application/octet-stream',
                 'attachment', 1, 'uploaded', '2026-08-28 01:00:00', NULL, ?)`,
    )
      .bind(uploadId, userId, mailboxId, kvKey, now)
      .run();
    await env.CACHE.put(kvKey, new Uint8Array([7]), { expirationTtl: 3600 });
    const ids = {
      uuid: vi
        .fn()
        .mockReturnValueOnce(uploadId)
        .mockReturnValueOnce(idempotencyId)
        .mockReturnValueOnce(crypto.randomUUID()),
    };

    await expect(
      uploadAttachment(
        {
          db: env.DB,
          cache: getAttachmentByteStore(env),
          auditEventWriter: createAuditEventWriter(env.DB),
          ids,
        },
        {
          actorUserId: userId,
          mailboxId,
          idempotencyKey: 'attachment-preserve-state',
          isAdmin: false,
          metadata: {
            filename: 'replacement.bin',
            contentType: 'application/octet-stream',
            disposition: 'attachment',
          },
          bytes: UPLOAD_BYTES.buffer,
          requestId: crypto.randomUUID(),
        },
      ),
    ).rejects.toThrow();

    expect(await env.CACHE.get(kvKey, 'arrayBuffer')).not.toBeNull();
    expect(await countRows('attachment_uploads')).toBe(1);
    expect(await countRows('idempotency_records')).toBe(0);
  });
});
