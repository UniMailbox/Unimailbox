import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  resetAndMigrate,
  seedInstallationState,
  seedResourceUsageActor,
} from '@unimailbox/test-kit';
import { DEFAULT_AI_GOVERNANCE_POLICY } from '@unimailbox/contracts';
import { app } from '../../entrypoints/http';
import { createAiGovernance } from '../../modules/ai';
import { createAuditEventWriter } from '../../modules/admin';
let token: string;
beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  token = await seedResourceUsageActor(true, env.CACHE);
});
const get = (path: string, auth = true) =>
  app.fetch(
    new Request(`http://localhost/api/v1${path}`, {
      headers: auth ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  );
async function grantManage() {
  for (const permission of ['settings.read', 'settings.manage']) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO permissions(id,key,description) VALUES (?,?,'Synthetic')",
    )
      .bind(permission, permission)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO role_permissions(role_id,permission_id) VALUES ('analytics-role',?)",
    )
      .bind(permission)
      .run();
  }
}
const save = (key = 'policy-fixture', revision = '0', mode = 'observe') =>
  app.fetch(
    new Request('http://localhost/api/v1/admin/ai-governance', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': key,
        'If-Match': revision,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...DEFAULT_AI_GOVERNANCE_POLICY, mode }),
    }),
    env,
  );
describe('CAP-072 governance API R-AUTHZ-003 R-SECRET-003', () => {
  it('requires authentication, keeps own usage separate and checks admin permissions', async () => {
    expect((await get('/auth/me/ai-usage', false)).status).toBe(401);
    const own = await get('/auth/me/ai-usage');
    expect(own.status).toBe(200);
    expect(own.headers.get('Cache-Control')).toBe('no-store');
    expect((await get('/admin/ai-governance')).status).toBe(403);
    expect((await save()).status).toBe(403);
    expect((await get('/admin/ai-governance/usage?userId=invalid')).status).toBe(400);
    await env.DB.prepare(
      "DELETE FROM role_permissions WHERE role_id='analytics-role' AND permission_id='analytics.read'",
    ).run();
    expect((await get('/admin/ai-governance/usage')).status).toBe(403);
  });
  it('replays policy changes, refuses stale writes and rolls audit failures back', async () => {
    await grantManage();
    const first = await save();
    expect(first.status).toBe(200);
    expect(await (await save()).text()).toBe(await first.text());
    expect((await save('policy-another', '0')).status).toBe(412);
    await env.DB.exec(
      "CREATE TRIGGER fail_policy_audit BEFORE INSERT ON audit_events WHEN NEW.action='ai.governance_updated' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
    );
    expect((await save('policy-failed', '1', 'paused')).status).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT policy_revision FROM ai_governance_breaker WHERE id='system'",
      ).first('policy_revision'),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM idempotency_records WHERE idempotency_key='policy-failed'",
      ).first('n'),
    ).toBe(0);
  });
  it('never exposes another user attempts through the personal query and bounds installation output', async () => {
    await env.DB.prepare(
      `INSERT INTO users(id,email,status,password_algorithm,password_iterations,password_salt,password_hash)
      VALUES ('10000000-0000-4000-8000-000000000002','other@example.test','active','pbkdf2-sha256',100000,x'00',x'11')`,
    ).run();
    const g = createAiGovernance(env.DB, createAuditEventWriter(env.DB));
    await g.reserve(
      {
        enabled: true,
        model: 'synthetic',
        protocol: 'openai',
        baseUrl: null,
        maxOutputTokens: 10,
        timeoutMs: 1000,
      },
      0,
      { messages: [{ role: 'user', content: 'private fixture' }], output: { type: 'text' } },
      {
        actorUserId: '10000000-0000-4000-8000-000000000002',
        idempotencyKey: 'different-user-key',
        requestHash: 'a'.repeat(64),
        requestId: 'synthetic',
      },
    );
    const own = await (
      await get('/auth/me/ai-usage?userId=10000000-0000-4000-8000-000000000002')
    ).json<{ data: { attempts: unknown[] } }>();
    expect(own.data.attempts).toEqual([]);
    const aggregate = await (await get('/admin/ai-governance/usage')).text();
    expect(aggregate).toContain('10000000-0000-4000-8000-000000000002');
    expect(aggregate).not.toContain('private fixture');
    expect(aggregate).not.toContain('different-user-key');
  });
});
