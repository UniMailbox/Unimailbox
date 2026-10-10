import { beforeEach, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { hashPassword } from '../../platform/crypto';
import type { PersonalSettings } from '@unimailbox/contracts';
let actor: string;
let token: string;
let mailbox: string;
let other: string;
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1kAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);
beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  actor = crypto.randomUUID();
  token = crypto.randomUUID();
  mailbox = crypto.randomUUID();
  other = crypto.randomUUID();
  const session = crypto.randomUUID(),
    domain = crypto.randomUUID();
  const password = await hashPassword('test123');
  await env.DB.batch([
    ...[actor, other].map((id) =>
      env.DB.prepare(
        `INSERT INTO users(id,email,display_name,status,password_algorithm,password_iterations,password_salt,password_hash) VALUES (?,?,'Tester','active',?,?,?,?)`,
      ).bind(
        id,
        `${id}@example.com`,
        password.algorithm,
        password.iterations,
        password.salt,
        password.hash,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at) VALUES (?,?,?,2000000000)`,
    ).bind(session, actor, crypto.randomUUID()),
    env.DB.prepare(
      `INSERT INTO managed_domains(id,name,status) VALUES (?,'example.com','active')`,
    ).bind(domain),
    env.DB.prepare(
      `INSERT INTO mailboxes(id,domain_id,owner_user_id,local_part,display_name,status) VALUES (?,?,?,'tester','','active')`,
    ).bind(mailbox, domain, actor),
  ]);
  await env.CACHE.put(`auth:${token}`, JSON.stringify({ userId: actor, sessionId: session }));
});
function request(
  path = 'preferences',
  method = 'GET',
  body?: Record<string, unknown> | Uint8Array,
  options: { key?: string; auth?: boolean; type?: string } = {},
) {
  return SELF.fetch(`https://example.com/api/v1/auth/me/${path}`, {
    method,
    headers: {
      ...(options.auth === false ? {} : { Authorization: `Bearer ${token}` }),
      'Idempotency-Key': options.key ?? crypto.randomUUID(),
      'Content-Type':
        options.type ?? (body instanceof Uint8Array ? 'image/png' : 'application/json'),
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
}
async function settings(): Promise<PersonalSettings> {
  return (await (await request()).json<{ data: PersonalSettings }>()).data;
}
it('lets a member read defaults and persists partial account preferences without administrator grants', async () => {
  expect((await settings()).preferences).toEqual({
    language: 'en',
    theme: 'system',
    density: 'comfortable',
    readingPane: 'none',
    defaultMailboxId: null,
  });
  const key = crypto.randomUUID();
  const first = await request(
    'preferences',
    'PATCH',
    { language: 'zh-CN', defaultMailboxId: mailbox },
    { key },
  );
  expect(first.status).toBe(200);
  const body = await first.text();
  expect(
    await (
      await request(
        'preferences',
        'PATCH',
        { language: 'zh-CN', defaultMailboxId: mailbox },
        { key },
      )
    ).text(),
  ).toBe(body);
  expect((await request('preferences', 'PATCH', { language: 'en' }, { key })).status).toBe(409);
  expect(
    (await request('preferences', 'PATCH', { density: 'compact', readingPane: 'right' })).status,
  ).toBe(200);
  expect((await settings()).preferences).toMatchObject({
    language: 'zh-CN',
    density: 'compact',
    readingPane: 'right',
    defaultMailboxId: mailbox,
  });
  const audit = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM audit_events WHERE action='user.preferences_updated'",
  ).first<{ count: number }>();
  expect(audit?.count).toBe(2);
  expect(
    await env.DB.prepare('SELECT * FROM user_preferences WHERE user_id=?').bind(other).first(),
  ).toBeNull();
});
it('rejects anonymous, forced-password-change, foreign mailbox and malformed settings', async () => {
  expect((await request('preferences', 'GET', undefined, { auth: false })).status).toBe(401);
  expect((await request('preferences', 'PATCH', {})).status).toBe(400);
  for (const patch of [
    { language: 'fr' },
    { density: 'tiny' },
    { userId: other },
    { defaultMailboxId: 'bad' },
  ])
    expect((await request('preferences', 'PATCH', patch)).status).toBe(400);
  await env.DB.prepare('UPDATE mailboxes SET owner_user_id=? WHERE id=?')
    .bind(other, mailbox)
    .run();
  expect((await request('preferences', 'PATCH', { defaultMailboxId: mailbox })).status).toBe(403);
  await env.DB.prepare('UPDATE users SET must_change_password=1 WHERE id=?').bind(actor).run();
  expect((await request()).status).toBe(403);
  expect((await request('avatar', 'POST', png)).status).toBe(403);
});
it('requires an idempotency key and keeps settings and audit writes atomic', async () => {
  const missing = await SELF.fetch('https://example.com/api/v1/auth/me/preferences', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}` },
    body: '{"language":"zh-CN"}',
  });
  expect(missing.status).toBe(400);
  await env.DB.exec(
    "CREATE TRIGGER fail_preferences_audit BEFORE INSERT ON audit_events WHEN NEW.action='user.preferences_updated' BEGIN SELECT RAISE(ABORT,'qa_atomicity'); END",
  );
  expect((await request('preferences', 'PATCH', { language: 'zh-CN' })).status).toBe(500);
  expect((await settings()).preferences.language).toBe('en');
  expect(
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation LIKE '%/auth/me/preferences'",
      ).first<{ count: number }>()
    )?.count,
  ).toBe(0);
});
it('stores private raster avatar bytes in R2, replaces and removes them idempotently', async () => {
  const key = crypto.randomUUID();
  const upload = await request('avatar', 'POST', png, { key });
  expect(upload.status).toBe(200);
  const first = await upload.json<{ data: PersonalSettings }>();
  expect(first.data.avatarVersion).toBeTruthy();
  expect(await (await request('avatar', 'POST', png, { key })).json()).toEqual(first);
  const stored = await env.DB.prepare(
    'SELECT avatar_object_key AS key FROM user_preferences WHERE user_id=?',
  )
    .bind(actor)
    .first<{ key: string }>();
  expect(stored?.key).toMatch(new RegExp(`^user-avatars/${actor}/`));
  const download = await request('avatar');
  expect(download.headers.get('Cache-Control')).toBe('private, no-store');
  expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);
  expect((await request('avatar', 'GET', undefined, { auth: false })).status).toBe(401);
  const second = await request('avatar', 'POST', png);
  expect(second.status).toBe(200);
  expect(stored && (await env.ATTACHMENTS.get(stored.key))).toBeNull();
  expect((await env.ATTACHMENTS.list({ prefix: `user-avatars/${actor}/` })).objects).toHaveLength(
    1,
  );
  expect((await request('avatar', 'DELETE')).status).toBe(200);
  expect((await settings()).avatarVersion).toBeNull();
  expect((await request('avatar')).status).toBe(404);
  expect((await env.ATTACHMENTS.list({ prefix: `user-avatars/${actor}/` })).objects).toHaveLength(
    0,
  );
});
it('rejects SVG, forged images, empty uploads and both declared and actual oversize bodies', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'image/png'])
    expect((await request('avatar', 'POST', new Uint8Array([1, 2, 3]), { type })).status).toBe(400);
  expect((await request('avatar', 'POST', new Uint8Array())).status).toBe(400);
  expect((await request('avatar', 'POST', new Uint8Array(2 * 1024 * 1024 + 1))).status).toBe(413);
  expect((await env.ATTACHMENTS.list({ prefix: `user-avatars/${actor}/` })).objects).toHaveLength(
    0,
  );
});
it('returns the canonical error envelope for unknown API paths', async () => {
  const response = await SELF.fetch('https://example.com/api/v1/missing-qa-route');
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    error: { code: 'NOT_FOUND', requestId: expect.any(String) },
  });
});
