import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';
import { DEFAULT_AI_CONFIGURATION } from '@unimailbox/contracts';
import { app } from '../../entrypoints/http';
import { updateAiConfiguration } from '../../modules/admin';
import { importEncryptionKey } from '../../platform/crypto';
import { readSecret } from '../../platform/secrets';

const owner = '00000000-0000-4000-8000-000000000001';
const member = '00000000-0000-4000-8000-000000000002';
const administrator = '00000000-0000-4000-8000-000000000003';
const mailboxId = '00000000-0000-4000-8000-000000000011';
const otherMailboxId = '00000000-0000-4000-8000-000000000012';
const messageId = '00000000-0000-4000-8000-000000000021';
const otherMessageId = '00000000-0000-4000-8000-000000000022';
const mailboxMessageId = '00000000-0000-4000-8000-000000000031';
const body = {
  subject: 'Re: Fixture',
  instructions: 'Ask for a date',
  draftBody: 'Thank you',
  language: 'en',
  sourceMessageId: messageId,
};
const now = '2026-01-01 00:00:00';
const upstreamReply = 'Thank you. When will it arrive?';
const result = (text = upstreamReply) =>
  Response.json({
    id: 'fixture',
    model: 'fixture-model',
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 10 },
  });
let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  for (const [id, role] of [
    [owner, 'member'],
    [member, 'member'],
    [administrator, 'administrator'],
  ]) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
        VALUES (?, ?, 'Fixture', 'active', 'PBKDF2', 100000, X'00', X'00', ?, ?)`,
      ).bind(id, `${id}@example.test`, now, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO roles (id, name, description, is_system, created_at) VALUES (?, ?, '', 1, ?)`,
      ).bind(role, role, now),
      env.DB.prepare(`INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`).bind(
        id,
        role,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, created_at) VALUES (?, ?, ?, 2000000000, ?)`,
      ).bind(id, id, id, now),
    ]);
    await env.CACHE.put(`auth:${id}`, JSON.stringify({ userId: id, sessionId: id }));
  }
  for (const key of ['message.read', 'message.send']) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, key, description, created_at) VALUES (?, ?, '', ?)`,
    )
      .bind(key, key, now)
      .run();
    for (const role of ['member', 'administrator'])
      await env.DB.prepare(
        `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)`,
      )
        .bind(role, key, now)
        .run();
  }
  const domainId = '00000000-0000-4000-8000-000000000041';
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, created_at, updated_at) VALUES (?, 'example.test', 'active', ?, ?)`,
  )
    .bind(domainId, now, now)
    .run();
  for (const [box, userId, msg, view] of [
    [mailboxId, owner, messageId, mailboxMessageId],
    [otherMailboxId, administrator, otherMessageId, 'other-view'],
  ]) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'active', ?, ?)`,
      ).bind(box, domainId, userId, box, now, now),
      env.DB.prepare(
        `INSERT INTO messages (id, from_address, from_name, subject, html_body, text_body, references_header, status, created_at, updated_at) VALUES (?, 'sender@example.test', 'Sender', 'Fixture original', '<p>HTML fixture</p>', 'Private original body', '', 'delivered', ?, ?)`,
      ).bind(msg, now, now),
      env.DB.prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at) VALUES (?, ?, ?, 0, 0, 'inbox', ?)`,
      ).bind(view, box, msg, now),
    ]);
  }
  await updateAiConfiguration(
    env.DB,
    async () => importEncryptionKey(await readSecret(env.CREDENTIAL_ENCRYPTION_KEY)),
    {
      actorUserId: administrator,
      expectedRevision: 0,
      idempotencyKey: 'fixture-ai-config',
      requestHash: 'a'.repeat(64),
      requestId: null,
      workersAiAvailable: false,
      request: {
        configuration: {
          ...DEFAULT_AI_CONFIGURATION,
          enabled: true,
          protocol: 'openai',
          model: 'fixture-model',
        },
        apiKey: 'synthetic-ai-key',
      },
    },
  );
});
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function mockUpstream(implementation: typeof fetch = async () => result()) {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(implementation);
  return fetchSpy;
}
function post({
  userId = owner,
  key = crypto.randomUUID(),
  request = body,
  box = mailboxId,
}: {
  userId?: string;
  key?: string;
  request?: unknown;
  box?: string;
} = {}) {
  return app.fetch(
    new Request(`http://localhost/api/v1/mailboxes/${box}/ai-reply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userId}`,
        'Idempotency-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    }),
    env,
  );
}
async function addMember(role: string) {
  await env.DB.prepare(
    `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(mailboxId, member, role, now)
    .run();
}

describe('AI email reply HTTP in workerd (synthetic upstream)', () => {
  it('keeps the reservation when audit settlement rolls back, preventing a second inference', async () => {
    await env.DB.exec(
      `CREATE TRIGGER deny_ai_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'message.ai_reply_generated' BEGIN SELECT RAISE(ABORT, 'fixture audit rollback'); END;`,
    );
    const upstream = mockUpstream();
    const key = 'fixture-audit-rollback';
    expect((await post({ key })).status).toBe(500);
    expect((await post({ key })).status).toBe(409);
    expect(upstream).toHaveBeenCalledOnce();
  });
  for (const text of ['', 'x'.repeat(16001), '\u0000'.repeat(13000)])
    it(`rejects empty or oversized serialized output (${text.length} chars)`, async () => {
      mockUpstream(async () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        }),
      );
      const response = await post();
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: 'AI_INVALID_RESPONSE' } });
    });
  it('R-AUTHZ-003/004 generates for an owner, bounds source context, and audits without body content', async () => {
    let prompt = '';
    const upstream = mockUpstream(async (_url, init) => {
      prompt = String(init?.body);
      return result();
    });
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { text: upstreamReply } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(upstream).toHaveBeenCalledOnce();
    expect(prompt).toContain('Private original body');
    expect(prompt).toContain('Ask for a date');
    const audit = await env.DB.prepare(
      `SELECT metadata FROM audit_events WHERE action = 'message.ai_reply_generated'`,
    ).first<{ metadata: string }>();
    expect(JSON.parse(audit?.metadata ?? '{}')).toMatchObject({ outcome: 'success', mailboxId });
    expect(audit?.metadata).not.toContain('Private original body');
    expect(audit?.metadata).not.toContain(upstreamReply);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) AS count FROM outbound_jobs').first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });
  it('removes inline reasoning before the reply response and idempotency replay', async () => {
    const reasoning = 'Synthetic private reasoning that must not reach the editor.';
    const upstream = mockUpstream(async () =>
      result(`<think>${reasoning}</think>\n${upstreamReply}`),
    );
    const key = 'fixture-clean-final-answer';
    const first = await post({ key });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ data: { text: upstreamReply } });
    const replay = await post({ key });
    expect(await replay.json()).toEqual({ data: { text: upstreamReply } });
    expect(upstream).toHaveBeenCalledTimes(1);
    const cached = await env.DB.prepare(
      'SELECT response_json FROM idempotency_records WHERE idempotency_key = ?',
    )
      .bind(key)
      .first<{ response_json: string }>();
    expect(cached?.response_json).not.toContain(reasoning);
    expect(cached?.response_json).not.toContain('<think>');
  });
  for (const role of ['sender', 'admin'])
    it(`R-AUTHZ-003 allows mailbox ${role}`, async () => {
      await addMember(role);
      mockUpstream();
      expect((await post({ userId: member })).status).toBe(200);
    });
  for (const actor of ['viewer', 'nonmember', 'global-administrator'])
    it(`R-AUTHZ-003/004 denies ${actor} before inference`, async () => {
      if (actor === 'viewer') await addMember('viewer');
      const upstream = mockUpstream();
      expect(
        (await post({ userId: actor === 'global-administrator' ? administrator : member })).status,
      ).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    });
  for (const permission of ['message.read', 'message.send'])
    it(`R-AUTHZ-003 requires global ${permission}`, async () => {
      await env.DB.prepare('DELETE FROM role_permissions WHERE role_id = ? AND permission_id = ?')
        .bind('member', permission)
        .run();
      const upstream = mockUpstream();
      expect((await post()).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
    });
  it('R-AUTHZ-004 rejects a source from another mailbox', async () => {
    const upstream = mockUpstream();
    expect((await post({ request: { ...body, sourceMessageId: otherMessageId } })).status).toBe(
      404,
    );
    expect(upstream).not.toHaveBeenCalled();
  });
  it('R-MESSAGE-005 rejects a caller-deleted source', async () => {
    await env.DB.prepare(
      'INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, is_starred, is_deleted, updated_at) VALUES (?, ?, 0, 0, 1, ?)',
    )
      .bind(mailboxMessageId, owner, now)
      .run();
    const upstream = mockUpstream();
    expect((await post()).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('R-API-004 replays without inference and rejects changed body or mailbox', async () => {
    const upstream = mockUpstream();
    const key = 'fixture-replay-key';
    const first = await (await post({ key })).text();
    expect(await (await post({ key })).text()).toBe(first);
    expect((await post({ key, request: { ...body, instructions: 'Changed' } })).status).toBe(409);
    await addMember('sender');
    // This actor can access both boxes, but a cached response never crosses the request resource.
    await env.DB.prepare('UPDATE mailboxes SET owner_user_id = ? WHERE id = ?')
      .bind(owner, otherMailboxId)
      .run();
    expect(
      (
        await post({
          key,
          box: otherMailboxId,
          request: { ...body, sourceMessageId: otherMessageId },
        })
      ).status,
    ).toBe(409);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('R-API-004 reserves concurrent same-key calls before paid inference', async () => {
    let release!: () => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = mockUpstream(async () => {
      notify();
      await hold;
      return result();
    });
    const key = 'fixture-concurrent-key';
    const first = post({ key });
    await started;
    try {
      const second = await post({ key });
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_REQUEST_PENDING' } });
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect((await post({ key })).status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('R-SECRET-003 stores sanitized failure and replays it without another inference', async () => {
    const upstream = mockUpstream(async () =>
      Response.json(
        { error: { message: 'PRIVATE PROVIDER BODY', type: 'fixture' } },
        { status: 500 },
      ),
    );
    const key = 'fixture-failed-key';
    const response = await post({ key });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain('AI_UPSTREAM_ERROR');
    expect(text).not.toContain('PRIVATE');
    expect(await (await post({ key })).text()).toBe(text);
    expect(upstream).toHaveBeenCalledOnce();
  });
  it('uses HTML-only mail as bounded quoted text and permits a new-mail draft', async () => {
    await env.DB.prepare(`UPDATE messages SET text_body = '', html_body = ? WHERE id = ?`)
      .bind('<script>secret-script</script><p>HTML only</p>' + 'x'.repeat(30000), messageId)
      .run();
    const prompts: string[] = [];
    mockUpstream(async (_url, init) => {
      prompts.push(String(init?.body));
      return result();
    });
    expect((await post()).status).toBe(200);
    expect(prompts[0]).toContain('HTML only');
    expect(prompts[0]).not.toContain('secret-script');
    expect(prompts[0]?.length).toBeLessThan(27000);
    expect(
      (
        await post({
          request: { subject: 'New email', language: 'zh-CN', instructions: 'Introduce our team' },
        })
      ).status,
    ).toBe(200);
    expect(prompts[1]).not.toContain('HTML only');
    expect(prompts[1]).toContain('Draft a new email');
  });
  it('actual Worker entry rejects disabled service and invalid request/idempotency input', async () => {
    await env.DB.prepare(`UPDATE ai_configuration SET configuration = ? WHERE id = 'system'`)
      .bind(JSON.stringify(DEFAULT_AI_CONFIGURATION))
      .run();
    const response = await SELF.fetch(`http://localhost/api/v1/mailboxes/${mailboxId}/ai-reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}`, 'Idempotency-Key': 'fixture-disabled-key' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'AI_DISABLED' } });
    expect((await post({ request: { ...body, userId: administrator } })).status).toBe(400);
    expect((await post({ request: { ...body, draftBody: 'x'.repeat(16001) } })).status).toBe(400);
    expect((await post({ key: 'bad' })).status).toBe(400);
  });
  it('R-AUTHZ-003 guards replay after mailbox membership revocation', async () => {
    await addMember('sender');
    const upstream = mockUpstream();
    const key = 'fixture-revoked-key';
    expect((await post({ userId: member, key })).status).toBe(200);
    await env.DB.prepare('DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?')
      .bind(mailboxId, member)
      .run();
    expect((await post({ userId: member, key })).status).toBe(403);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
