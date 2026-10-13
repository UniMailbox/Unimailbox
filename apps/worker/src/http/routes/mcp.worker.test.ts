import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { encrypt, importEncryptionKey } from '../../platform/crypto';
import { DEFAULT_MCP_PROMPT_TEMPLATE } from '@unimailbox/contracts';
import { readSecret } from '../../platform/secrets';

const user = '00000000-0000-4000-8000-000000000001';
const box = '00000000-0000-4000-8000-000000000011';
const otherBox = '00000000-0000-4000-8000-000000000012';
const message = '00000000-0000-4000-8000-000000000021';
const now = '2026-01-01 00:00:00';
const BASE = 'http://localhost';
const config = { enabled: true, promptTemplate: DEFAULT_MCP_PROMPT_TEMPLATE };
const adminHeaders = () => ({
  Authorization: `Bearer ${user}`,
  'Content-Type': 'application/json',
  'Idempotency-Key': crypto.randomUUID(),
});
async function save(configuration = config, revision = 0) {
  return SELF.fetch(`${BASE}/api/v1/admin/mcp`, {
    method: 'PUT',
    headers: { ...adminHeaders(), 'If-Match': String(revision) },
    body: JSON.stringify(configuration),
  });
}
async function issue(
  allowDraft = false,
  allowSend = false,
  headers = adminHeaders(),
  mailboxIds = [box],
) {
  return SELF.fetch(`${BASE}/api/v1/auth/me/mcp/tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      label: 'Fixture agent',
      mailboxIds,
      allowDraft,
      allowSend,
      expiresInDays: 1,
    }),
  });
}
async function token(allowDraft = false, allowSend = false) {
  const response = await issue(allowDraft, allowSend);
  expect(response.status).toBe(200);
  return (await response.json<{ data: { token: string; credential: { id: string } } }>()).data;
}
async function rpc(
  credential: string,
  method: string,
  params: unknown = {},
  headers: Record<string, string> = {},
) {
  return SELF.fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
async function rpcJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(
    (text.startsWith('event:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice(6)
      : text) ?? '',
  ) as T;
}
async function call(credential: string, name: string, args: unknown = {}) {
  const response = await rpc(credential, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  return rpcJson<{
    result?: { isError?: boolean; content: Array<{ text: string }> };
    error?: unknown;
  }>(response);
}

beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users(id,email,display_name,status,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at) VALUES(?, 'fixture@example.test','Fixture','active','PBKDF2',100000,X'00',X'00',?,?)`,
    ).bind(user, now, now),
    env.DB.prepare(
      `INSERT INTO roles(id,name,description,is_system,created_at) VALUES('administrator','administrator','',1,?)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO user_roles(user_id,role_id,granted_at) VALUES(?,'administrator',?)`,
    ).bind(user, now),
    env.DB.prepare(
      `INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,created_at) VALUES(?,?,?,2000000000,?)`,
    ).bind(user, user, user, now),
    env.DB.prepare(
      `INSERT INTO managed_domains(id,name,status,created_at,updated_at) VALUES('fixture-domain','example.test','active',?,?)`,
    ).bind(now, now),
    ...[box, otherBox].map((id) =>
      env.DB.prepare(
        `INSERT INTO mailboxes(id,domain_id,owner_user_id,local_part,display_name,status,created_at,updated_at) VALUES(?,'fixture-domain',?,?,'Fixture','active',?,?)`,
      ).bind(id, user, id, now, now),
    ),
    env.DB.prepare(
      `INSERT INTO messages(id,from_address,from_name,subject,html_body,text_body,references_header,status,created_at,updated_at) VALUES(?,'sender@example.test','Sender','Fixture','<p>Body</p>','Untrusted mail content','','delivered',?,?)`,
    ).bind(message, now, now),
    env.DB.prepare(
      `INSERT INTO mailbox_messages(id,mailbox_id,message_id,is_read,is_starred,folder,created_at) VALUES('fixture-view',?,?,0,0,'inbox',?)`,
    ).bind(box, message, now),
  ]);
  for (const key of ['settings.read', 'settings.manage', 'message.read', 'message.send'])
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions(id,key,description,created_at) VALUES(?,?,'',?)`,
      ).bind(key, key, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO role_permissions(role_id,permission_id,created_at) VALUES('administrator',?,?)`,
      ).bind(key, now),
    ]);
  await env.CACHE.put(`auth:${user}`, JSON.stringify({ userId: user, sessionId: user }));
});

describe('MCP administration and Streamable HTTP', () => {
  it('R-AUTHZ-003 R-AUTHZ-004: members manage only their own credentials without settings permissions', async () => {
    await save();
    const member = '00000000-0000-4000-8000-000000000002';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users(id,email,status,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at) SELECT ?,'member@example.test','active',password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at FROM users WHERE id=?`,
      ).bind(member, user),
      env.DB.prepare(
        `INSERT INTO roles(id,name,description,is_system,created_at) VALUES('member','member','',1,?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO user_roles(user_id,role_id,granted_at) VALUES(?,'member',?)`,
      ).bind(member, now),
      ...['message.read', 'message.send'].map((permission) =>
        env.DB.prepare(
          `INSERT INTO role_permissions(role_id,permission_id,created_at) VALUES('member',?,?)`,
        ).bind(permission, now),
      ),
      env.DB.prepare('INSERT INTO mailbox_members(mailbox_id,user_id,role) VALUES(?,?,?)').bind(
        box,
        member,
        'sender',
      ),
      env.DB.prepare(
        'INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at,created_at) VALUES(?,?,?,2000000000,?)',
      ).bind(member, member, member, now),
    ]);
    await env.CACHE.put(`auth:${member}`, JSON.stringify({ userId: member, sessionId: member }));
    const headers = () => ({ ...adminHeaders(), Authorization: `Bearer ${member}` });
    expect((await SELF.fetch(`${BASE}/api/v1/admin/mcp`, { headers: headers() })).status).toBe(403);
    expect(
      (
        await SELF.fetch(`${BASE}/api/v1/admin/mcp`, {
          method: 'PUT',
          headers: { ...headers(), 'If-Match': '1' },
          body: JSON.stringify(config),
        })
      ).status,
    ).toBe(403);
    const personal = await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`, { headers: headers() });
    expect(await personal.json()).toMatchObject({
      data: { enabled: true, mailboxes: [{ id: box, canWrite: true }], tokens: [] },
    });
    expect((await issue(false, false, headers(), [otherBox])).status).toBe(403);
    const issued = await issue(false, true, headers());
    expect(issued.status).toBe(200);
    const mine = (await issued.json<{ data: { token: string; credential: { id: string } } }>())
      .data;
    const owner = await token();
    const otherRevoke = await SELF.fetch(
      `${BASE}/api/v1/auth/me/mcp/tokens/${owner.credential.id}/revoke`,
      { method: 'POST', headers: headers() },
    );
    expect(otherRevoke.status).toBe(404);
    const listing = await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`, { headers: headers() });
    expect(await listing.json()).toMatchObject({ data: { tokens: [{ id: mine.credential.id }] } });
    await env.DB.prepare("UPDATE mailbox_members SET role='viewer' WHERE user_id=?")
      .bind(member)
      .run();
    expect((await issue(true, false, headers())).status).toBe(403);
    expect((await issue(false, true, headers())).status).toBe(403);
    expect((await issue(false, false, headers())).status).toBe(200);
    const viewer = await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`, { headers: headers() });
    expect(await viewer.json()).toMatchObject({
      data: { mailboxes: [{ id: box, canWrite: false }] },
    });
    expect(
      (
        await call(mine.token, 'send_email', {
          mailboxId: box,
          subject: 'Fixture',
          body: 'Synthetic',
          to: ['recipient@example.test'],
          confirmed: true,
          idempotencyKey: 'viewer-denied-key',
        })
      ).result?.isError,
    ).toBe(true);
    await save({ ...config, enabled: false }, 1);
    expect((await issue(false, false, headers())).status).toBe(503);
    expect(
      (
        await SELF.fetch(`${BASE}/api/v1/auth/me/mcp/tokens/${mine.credential.id}/revoke`, {
          method: 'POST',
          headers: headers(),
        })
      ).status,
    ).toBe(200);
    await env.DB.prepare('UPDATE users SET must_change_password=1 WHERE id=?').bind(member).run();
    expect((await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`, { headers: headers() })).status).toBe(
      403,
    );
    expect((await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`)).status).toBe(401);
  });

  it('persists shared prompts with revision checks without accepting credentials', async () => {
    const configuration = { ...config, promptTemplate: 'Fixture agent connects to {{endpoint}}.' };
    expect((await save(configuration)).status).toBe(200);
    const personal = await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`, { headers: adminHeaders() });
    expect(await personal.json()).toMatchObject({
      data: { promptTemplate: configuration.promptTemplate },
    });
    expect(
      (await save({ ...configuration, promptTemplate: '{{endpoint}} umcp_' + 'a'.repeat(64) }, 1))
        .status,
    ).toBe(400);
    expect((await save(config)).status).toBe(412);
    const read = await SELF.fetch(`${BASE}/api/v1/admin/mcp`, { headers: adminHeaders() });
    const result = await read.json<{ data: Record<string, unknown> }>();
    expect(result.data).not.toHaveProperty('tokens');
    expect(result.data).not.toHaveProperty('mailboxes');
    expect(result.data).toMatchObject({ configuration, revision: 1 });
  });

  it('defaults disabled, protects administration and rejects stale revisions', async () => {
    expect((await rpc('', 'tools/list')).status).toBe(503);
    expect((await SELF.fetch(`${BASE}/api/v1/admin/mcp`)).status).toBe(401);
    const response = await SELF.fetch(`${BASE}/api/v1/admin/mcp`, { headers: adminHeaders() });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      data: {
        configuration: { enabled: false, promptTemplate: DEFAULT_MCP_PROMPT_TEMPLATE },
        endpoint: `${BASE}/api/mcp`,
      },
    });
    expect((await save()).status).toBe(200);
    expect((await save()).status).toBe(412);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE permission_id='settings.manage'",
    ).run();
    expect((await save(config, 1)).status).toBe(403);
    expect((await issue()).status).toBe(200);
  });

  it('shows credentials only once and stores only hashes and safe replay metadata', async () => {
    expect((await save()).status).toBe(200);
    const headers = adminHeaders();
    const first = await issue(false, false, headers);
    const data = await first.json<{ data: { token: string; credential: { id: string } } }>();
    expect(data.data.token).toMatch(/^umcp_[a-f0-9]{64}$/);
    const second = await issue(false, false, headers);
    expect(await second.json()).toMatchObject({
      data: { credential: { id: data.data.credential.id }, token: null },
    });
    const persisted =
      JSON.stringify(await env.DB.prepare('SELECT * FROM mcp_tokens').all()) +
      JSON.stringify(await env.DB.prepare('SELECT * FROM idempotency_records').all()) +
      JSON.stringify(await env.DB.prepare('SELECT * FROM audit_events').all());
    expect(persisted).not.toContain(data.data.token);
    expect(persisted).not.toContain(`Bearer ${data.data.token}`);
    const read = await SELF.fetch(`${BASE}/api/v1/auth/me/mcp`, { headers: adminHeaders() });
    expect(await read.text()).not.toContain(data.data.token);
    expect((await rpc(user, 'tools/list')).status).toBe(401);
    expect(
      (
        await SELF.fetch(`${BASE}/api/v1/mailboxes`, {
          headers: { Authorization: `Bearer ${data.data.token}` },
        })
      ).status,
    ).toBe(401);
  });

  it('initializes, advertises scoped read tools and enforces mailbox boundaries', async () => {
    await save();
    const credential = await token();
    const initialized = await rpc(credential.token, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get('Cache-Control')).toBe('no-store');
    expect(await rpcJson(initialized)).toMatchObject({
      result: { serverInfo: { name: 'unimailbox' } },
    });
    const listing = await rpc(credential.token, 'tools/list');
    expect(listing.status).toBe(200);
    const names = (
      await rpcJson<{ result: { tools: Array<{ name: string }> } }>(listing)
    ).result.tools.map((tool) => tool.name);
    expect(names).toEqual(['list_mailboxes', 'list_messages', 'read_message']);
    const mailboxes = await call(credential.token, 'list_mailboxes');
    expect(JSON.parse(mailboxes.result?.content[0]?.text ?? '')).toEqual([
      expect.objectContaining({ id: box }),
    ]);
    const read = await call(credential.token, 'read_message', {
      mailboxId: box,
      messageId: message,
    });
    expect(JSON.parse(read.result?.content[0]?.text ?? '')).toMatchObject({
      text: 'Untrusted mail content',
      contentIsUntrusted: true,
    });
    expect(
      (await call(credential.token, 'read_message', { mailboxId: otherBox, messageId: message }))
        .result?.isError,
    ).toBe(true);
    expect((await call(credential.token, 'create_draft', {})).error).toBeDefined();
    const messages = await call(credential.token, 'list_messages', { mailboxId: box });
    expect(JSON.parse(messages.result?.content[0]?.text ?? '')).toMatchObject({
      items: [expect.objectContaining({ id: message })],
    });
  });

  it('separates draft/send scopes and retains draft idempotency', async () => {
    await save();
    const draft = await token(true);
    const args = {
      mailboxId: box,
      subject: 'Fixture draft',
      body: '<script>test</script>\nhello',
      to: ['recipient@example.test'],
      idempotencyKey: 'fixture-draft-key',
    };
    const first = await call(draft.token, 'create_draft', args);
    expect(first.result?.isError).toBe(false);
    expect(await call(draft.token, 'create_draft', args)).toEqual(first);
    expect(
      (await call(draft.token, 'send_email', { ...args, confirmed: true })).error,
    ).toBeDefined();

    const send = await token(false, true);
    const tools = await rpc(send.token, 'tools/list');
    const names = (
      await rpcJson<{ result: { tools: Array<{ name: string }> } }>(tools)
    ).result.tools.map((tool) => tool.name);
    expect(names).toContain('send_email');
    expect(names).not.toContain('create_draft');
    expect((await call(send.token, 'send_email', args)).result?.isError).toBe(true);
    await save({ ...config, enabled: false }, 1);
    expect((await rpc(send.token, 'tools/list')).status).toBe(503);
  });

  it('queues an authorized send once and rejects retries after live send permission is removed', async () => {
    await save();
    const credential = await token(false, true);
    const encrypted = await encrypt(
      'synthetic-brevo-key',
      await importEncryptionKey(await readSecret(env.CREDENTIAL_ENCRYPTION_KEY)),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO encrypted_credentials(id,name,version,ciphertext,iv,auth_tag,created_at,updated_at) VALUES('fixture-secret','brevo-api-key',1,?,?,?,?,?)`,
      ).bind(encrypted.ciphertext, encrypted.iv, encrypted.authTag, now, now),
      env.DB.prepare(
        `INSERT INTO provider_connections(id,provider_key,label,credential_id,status,created_at,updated_at) VALUES('fixture-provider','brevo','Fixture','fixture-secret','active',?,?)`,
      ).bind(now, now),
      env.DB.prepare(
        "UPDATE managed_domains SET outbound_connection_id='fixture-provider' WHERE id='fixture-domain'",
      ),
    ]);
    const queue = vi.spyOn(env.OUTBOUND, 'send').mockResolvedValue(undefined);
    try {
      const args = {
        mailboxId: box,
        subject: 'Fixture send',
        body: 'Synthetic only',
        to: ['recipient@example.test'],
        bcc: ['hidden@example.test'],
        confirmed: true,
        idempotencyKey: 'fixture-send-key',
      };
      const first = await call(credential.token, 'send_email', args);
      expect(first.result?.isError).toBe(false);
      const accepted = JSON.parse(first.result?.content[0]?.text ?? '');
      expect(accepted).toMatchObject({ status: 'queued' });
      expect(await call(credential.token, 'send_email', args)).toEqual(first);
      expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM outbound_jobs').first()).toEqual({
        count: 1,
      });
      expect(queue).toHaveBeenCalledTimes(1);
      await env.DB.prepare("DELETE FROM role_permissions WHERE permission_id='message.send'").run();
      expect((await call(credential.token, 'send_email', args)).result?.isError).toBe(true);
    } finally {
      queue.mockRestore();
    }
  });

  it('rejects hostile origins and oversize bodies, and limits concurrent requests', async () => {
    await save();
    const credential = await token();
    expect(
      (await rpc(credential.token, 'tools/list', {}, { Origin: 'https://hostile.test' })).status,
    ).toBe(403);
    const oversized = await rpc(credential.token, 'tools/list', {
      padding: 'x'.repeat(129 * 1024),
    });
    expect(oversized.status).toBe(413);
    const batch = await SELF.fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
    });
    expect(batch.status).toBe(400);
    await env.DB.prepare('UPDATE mcp_configuration SET requests_per_minute=2').run();
    const fresh = await token();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => rpc(fresh.token, 'tools/list')),
    );
    expect(results.map((response) => response.status).sort()).toEqual([200, 200, 429, 429]);
  });

  it('checks live grants, active account, expiry, revocation and service disable', async () => {
    await save();
    const credential = await token();
    await env.DB.prepare(
      `INSERT INTO users(id,email,display_name,status,password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at) SELECT 'other-user','other@example.test','Other','active',password_algorithm,password_iterations,password_salt,password_hash,created_at,updated_at FROM users WHERE id=?`,
    )
      .bind(user)
      .run();
    await env.DB.prepare('UPDATE mailboxes SET owner_user_id=? WHERE id=?')
      .bind('other-user', box)
      .run();
    expect(
      (await call(credential.token, 'read_message', { mailboxId: box, messageId: message })).result
        ?.isError,
    ).toBe(true);
    await env.DB.prepare('UPDATE mailboxes SET owner_user_id=? WHERE id=?').bind(user, box).run();
    await env.DB.prepare("UPDATE users SET status='banned' WHERE id=?").bind(user).run();
    expect((await rpc(credential.token, 'tools/list')).status).toBe(401);
    await env.DB.prepare("UPDATE users SET status='active' WHERE id=?").bind(user).run();
    await env.DB.prepare("DELETE FROM role_permissions WHERE permission_id='message.read'").run();
    expect((await call(credential.token, 'list_mailboxes')).result?.isError).toBe(true);
    await env.DB.prepare('UPDATE users SET must_change_password=1 WHERE id=?').bind(user).run();
    expect((await rpc(credential.token, 'tools/list')).status).toBe(401);
    await env.DB.prepare('UPDATE users SET must_change_password=0 WHERE id=?').bind(user).run();
    await env.DB.prepare('UPDATE mcp_tokens SET expires_at=0 WHERE id=?')
      .bind(credential.credential.id)
      .run();
    expect((await rpc(credential.token, 'tools/list')).status).toBe(401);
    await env.DB.prepare('UPDATE mcp_tokens SET expires_at=2000000000 WHERE id=?')
      .bind(credential.credential.id)
      .run();
    expect(
      (
        await SELF.fetch(`${BASE}/api/v1/auth/me/mcp/tokens/${credential.credential.id}/revoke`, {
          method: 'POST',
          headers: adminHeaders(),
        })
      ).status,
    ).toBe(200);
    expect((await rpc(credential.token, 'tools/list')).status).toBe(401);
    await save({ ...config, enabled: false }, 1);
    expect((await rpc(credential.token, 'tools/list')).status).toBe(503);
  });
});
