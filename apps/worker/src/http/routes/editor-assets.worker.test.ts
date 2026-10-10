import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import { expireEditorAssets, prepareEditorAssetUsages } from '../../modules/editor-assets';
import type { EditorAssetDescriptor } from '@unimailbox/contracts';
const domain = '00000000-0000-4000-8000-000000000001';
const mailbox = '00000000-0000-4000-8000-000000000002';
let actor: string;
let token: string;
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  actor = crypto.randomUUID();
  token = crypto.randomUUID();
  const session = crypto.randomUUID();
  const password = await hashPassword('Test-password-123');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id,email,display_name,status,password_algorithm,password_iterations,password_salt,password_hash) VALUES (?,?,'Tester','active',?,?,?,?)`,
    ).bind(
      actor,
      `${actor}@example.com`,
      password.algorithm,
      password.iterations,
      password.salt,
      password.hash,
    ),
    env.DB.prepare(
      `INSERT INTO roles (id,name,description,is_system) VALUES ('tester','tester','Test role',0)`,
    ),
    ...['message.send', 'signature.manage'].flatMap((key) => [
      env.DB.prepare(`INSERT OR IGNORE INTO permissions (id,key,description) VALUES (?,?,?)`).bind(
        key,
        key,
        key,
      ),
      env.DB.prepare(
        `INSERT INTO role_permissions (role_id,permission_id) VALUES ('tester',?)`,
      ).bind(key),
    ]),
    env.DB.prepare(`INSERT INTO user_roles (user_id,role_id) VALUES (?,'tester')`).bind(actor),
    env.DB.prepare(
      `INSERT INTO sessions (id,user_id,refresh_token_hash,expires_at) VALUES (?,?,?,2000000000)`,
    ).bind(session, actor, crypto.randomUUID()),
    env.DB.prepare(
      `INSERT INTO managed_domains (id,name,status) VALUES (?,'example.com','active')`,
    ).bind(domain),
    env.DB.prepare(
      `INSERT INTO mailboxes (id,domain_id,owner_user_id,local_part,display_name,status) VALUES (?,?,?,'tester','','active')`,
    ).bind(mailbox, domain, actor),
  ]);
  await env.CACHE.put(`auth:${token}`, JSON.stringify({ userId: actor, sessionId: session }));
});
function upload(
  bytes: Uint8Array,
  options: {
    key?: string;
    kind?: string;
    type?: string;
    size?: number;
    path?: string;
    auth?: boolean;
  } = {},
) {
  return SELF.fetch(
    `https://example.com/api/v1/${options.path ?? `mailboxes/${mailbox}/editor-assets`}`,
    {
      method: 'POST',
      headers: {
        ...(options.auth === false ? {} : { Authorization: `Bearer ${token}` }),
        'Idempotency-Key': options.key ?? crypto.randomUUID(),
        'X-Filename': encodeURIComponent('报告.pdf'),
        'X-Asset-Kind': options.kind ?? 'file',
        'X-File-Size': String(options.size ?? bytes.byteLength),
        'Content-Type': options.type ?? 'application/pdf',
      },
      body: bytes,
    },
  );
}
it('rejects full pending quotas before R2 I/O and validates replay bytes without another R2 write', async () => {
  const key = crypto.randomUUID();
  const first = await upload(new Uint8Array([1, 2, 3]), { key });
  const original = await first.json();
  await env.DB.prepare(
    `WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<99)
    INSERT INTO editor_assets (id,owner_user_id,mailbox_id,secret_hash,object_key,filename,content_type,size_bytes,kind,created_at,expires_at)
    SELECT 'quota-'||v,?,?,?,'editor-assets/quota-'||v,'quota.pdf','application/pdf',1,'file','2026-10-09 00:00:00','2099-01-01 00:00:00' FROM n`,
  )
    .bind(actor, mailbox, '0'.repeat(64))
    .run();
  const put = vi.spyOn(env.ATTACHMENTS, 'put');
  const remove = vi.spyOn(env.ATTACHMENTS, 'delete');
  expect((await upload(new Uint8Array([4]))).status).toBe(400);
  const replay = await upload(new Uint8Array([1, 2, 3]), { key });
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(original);
  expect((await upload(new Uint8Array([9, 2, 3]), { key })).status).toBe(409);
  expect(put).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
it('streams bytes into R2, replays one upload, and serves only the exact capability URL', async () => {
  const key = crypto.randomUUID();
  const bytes = new Uint8Array([1, 2, 3]);
  const response = await upload(bytes, { key });
  expect(response.status).toBe(201);
  const { data } = await response.json<{ data: EditorAssetDescriptor }>();
  expect(data.filename).toBe('报告.pdf');
  expect((await env.ATTACHMENTS.get(`editor-assets/${data.id}`))?.size).toBe(3);
  const replay = await upload(bytes, { key });
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ data });
  expect((await upload(new Uint8Array([4]), { key })).status).toBe(409);
  const download = await SELF.fetch(data.url);
  expect(download.status).toBe(200);
  expect(download.headers.get('Content-Disposition')).toContain('attachment;');
  expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual([1, 2, 3]);
  expect(
    (await SELF.fetch(data.url.slice(0, -1) + (data.url.endsWith('a') ? 'b' : 'a'))).status,
  ).toBe(404);
});
it('rejects unauthenticated/foreign-mailbox requests, forged images and incorrect size metadata', async () => {
  expect((await upload(new Uint8Array([1]), { auth: false })).status).toBe(401);
  expect(
    (await upload(new Uint8Array([1]), { path: `mailboxes/${crypto.randomUUID()}/editor-assets` }))
      .status,
  ).toBe(404);
  expect(
    (await upload(new Uint8Array([1, 2, 3]), { kind: 'image', type: 'image/png' })).status,
  ).toBe(400);
  expect((await upload(new Uint8Array([1]), { size: 2 })).status).toBe(400);
  expect((await upload(new Uint8Array([1]), { size: 100 * 1024 * 1024 + 1 })).status).toBe(413);
});
it('supports files beyond the JSON and legacy attachment cap without embedding bytes', async () => {
  const response = await upload(new Uint8Array(6 * 1024 * 1024));
  expect(response.status).toBe(201);
  const { data } = await response.json<{ data: EditorAssetDescriptor }>();
  expect(data.sizeBytes).toBe(6 * 1024 * 1024);
  expect(JSON.stringify(data).length).toBeLessThan(1024);
});
it('protects published files from expiry and prevents cross-scope publication', async () => {
  const result = await upload(new Uint8Array([1]));
  const { data } = await result.json<{ data: EditorAssetDescriptor }>();
  await expect(
    prepareEditorAssetUsages(env.DB, {
      html: `<a href="${data.url}">File</a>`,
      text: '',
      actorUserId: actor,
      scope: { domainId: domain },
      resourceType: 'signature',
      resourceId: crypto.randomUUID(),
    }),
  ).rejects.toThrow('unavailable');
  const statements = await prepareEditorAssetUsages(env.DB, {
    html: `<a href="${data.url}">File</a>`,
    text: '',
    actorUserId: actor,
    scope: { mailboxId: mailbox },
    resourceType: 'message',
    resourceId: crypto.randomUUID(),
  });
  await env.DB.batch(statements);
  await env.DB.prepare(`UPDATE editor_assets SET expires_at='2000-01-01 00:00:00' WHERE id=?`)
    .bind(data.id)
    .run();
  await expireEditorAssets(env.DB, env.ATTACHMENTS);
  expect((await SELF.fetch(data.url)).status).toBe(200);
  const pending = await upload(new Uint8Array([2]));
  const { data: unused } = await pending.json<{ data: EditorAssetDescriptor }>();
  await env.DB.prepare(`UPDATE editor_assets SET expires_at='2000-01-01 00:00:00' WHERE id=?`)
    .bind(unused.id)
    .run();
  await expireEditorAssets(env.DB, env.ATTACHMENTS);
  expect((await SELF.fetch(unused.url)).status).toBe(404);
  expect(await env.ATTACHMENTS.get(`editor-assets/${unused.id}`)).toBeNull();
});
it('accepts raster images for domain signatures with signature.manage', async () => {
  const response = await upload(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), {
    path: `admin/domains/${domain}/editor-assets`,
    kind: 'image',
    type: 'image/png',
  });
  expect(response.status).toBe(201);
  const { data } = await response.json<{ data: EditorAssetDescriptor }>();
  const image = await SELF.fetch(data.url);
  expect(image.headers.get('Content-Type')).toBe('image/png');
  expect(image.headers.get('Content-Disposition')).toContain('inline;');
});

it('exposes only upload limits to authenticated mailbox users without settings.read', async () => {
  const path = 'https://example.com/api/v1/editor-assets/policy';
  expect((await SELF.fetch(path)).status).toBe(401);
  const response = await SELF.fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { maxFileBytes: 100 * 1024 * 1024, maxImageBytes: 5 * 1024 * 1024 },
  });
});
it('enforces the system setting for mailbox files and domain images at the exact boundary', async () => {
  await env.DB.prepare(
    "INSERT INTO system_settings (key,value,updated_at,created_at) VALUES ('max_attachment_bytes','12','2026-10-07 00:00:00','2026-10-07 00:00:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run();
  const policy = await SELF.fetch('https://example.com/api/v1/editor-assets/policy', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await policy.json()).toEqual({ data: { maxFileBytes: 12, maxImageBytes: 12 } });
  const before = await env.ATTACHMENTS.list();
  expect((await upload(new Uint8Array(13))).status).toBe(413);
  expect(
    (
      await upload(new Uint8Array(13), {
        kind: 'image',
        type: 'image/png',
        path: `admin/domains/${domain}/editor-assets`,
      })
    ).status,
  ).toBe(413);
  expect((await env.ATTACHMENTS.list()).objects.length).toBe(before.objects.length);
  expect((await upload(new Uint8Array(12))).status).toBe(201);
  expect(
    (
      await upload(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]), {
        kind: 'image',
        type: 'image/png',
        path: `admin/domains/${domain}/editor-assets`,
      })
    ).status,
  ).toBe(201);
});
it('allows configured metadata above the old 64 MiB ceiling but still rejects an incomplete body', async () => {
  expect((await upload(new Uint8Array(1), { size: 65 * 1024 * 1024 })).status).toBe(400);
});
