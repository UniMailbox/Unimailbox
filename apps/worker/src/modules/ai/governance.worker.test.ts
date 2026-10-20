import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedInboundMailbox, seedInstallationState } from '@unimailbox/test-kit';
import {
  DEFAULT_AI_CONFIGURATION,
  DEFAULT_AI_GOVERNANCE_POLICY,
  type AiGovernancePolicy,
  type AiGenerateRequest,
  type AiAdapter,
} from '@unimailbox/contracts';
import { createAiGovernance, createAiService } from './index';
import { createAiAdapters } from '../../integrations/ai/registry';
import { createAuditEventWriter } from '../admin';
import { DomainError } from '../../platform/errors';

const actor = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const request: AiGenerateRequest = {
  messages: [{ role: 'user', content: 'private synthetic prompt' }],
  output: { type: 'text' },
};
const configuration = {
  ...DEFAULT_AI_CONFIGURATION,
  enabled: true,
  protocol: 'openai' as const,
  model: 'synthetic-model',
  maxOutputTokens: 100,
};
let at = new Date('2026-10-16T00:00:00Z');
const governance = () => createAiGovernance(env.DB, createAuditEventWriter(env.DB), () => at);
const invocation = (user = actor, key = crypto.randomUUID()) => ({
  actorUserId: user,
  idempotencyKey: key,
  requestHash: 'a'.repeat(64),
  requestId: 'synthetic-request',
});
async function policy(patch: Partial<AiGovernancePolicy> = {}) {
  const p = { ...DEFAULT_AI_GOVERNANCE_POLICY, ...patch };
  const g = governance();
  const current = await g.policy();
  await g.updatePolicy({ ...invocation(), policy: p, expectedRevision: current.revision });
  return p;
}
const profile = {
  configurationRevision: 0,
  contextTokens: 65536,
  overheadTokens: 1024,
  verificationReference: 'synthetic-test-evidence',
};
beforeEach(async () => {
  await resetAndMigrate();
  await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  await seedInboundMailbox();
  await env.DB.prepare(
    `INSERT INTO users(id,email,status,password_algorithm,password_iterations,password_salt,password_hash)
    VALUES (?,'other@example.test','active','pbkdf2-sha256',100000,x'00',x'11')`,
  )
    .bind(other)
    .run();
  at = new Date('2026-10-16T00:00:00Z');
});
afterEach(() => vi.useRealTimers());
const reserve = (user = actor, key = crypto.randomUUID()) =>
  governance().reserve(configuration, 0, request, invocation(user, key));

describe('CAP-072 AI governance R-API-004 R-AUDIT-001', () => {
  it('atomically admits only one concurrent operation against the shared last budget', async () => {
    const bound = new TextEncoder().encode(JSON.stringify(request)).byteLength + 1024 + 100;
    await policy({
      mode: 'enforce',
      verifiedProfile: profile,
      monthlyTokens: bound,
      dailyTokens: bound,
    });
    const results = await Promise.allSettled([reserve(actor), reserve(other)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM ai_attempts').first('n')).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM audit_events WHERE action='ai.attempt_reserved'",
      ).first('n'),
    ).toBe(1);
  });
  it('shares user concurrency across different keys and retains unknown capacity', async () => {
    const id = await reserve();
    await governance().transition(id, 'unknown');
    await expect(reserve()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await governance().usage(actor)).summary).toMatchObject({ unknown: 1, active: 0 });
    await governance().transition(id, 'failed', { inputTokens: 5, outputTokens: 2 });
    await expect(reserve()).resolves.toBeTypeOf('string');
  });
  it('does not allow an expired response key to submit another paid attempt', async () => {
    const key = crypto.randomUUID(),
      id = await reserve(actor, key);
    await governance().transition(id, 'success', { inputTokens: 5, outputTokens: 2 });
    at = new Date('2026-11-18T00:00:00Z');
    await expect(reserve(actor, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_REQUEST_PENDING',
    });
    expect((await governance().usage(actor)).summary.chargedTokens).toBe(0);
  });
  it('holds unknown attempts across month changes without charging the new period', async () => {
    const id = await reserve();
    await governance().transition(id, 'unknown');
    at = new Date('2026-11-01T00:00:00Z');
    await expect(reserve()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await governance().transition(id, 'success', { inputTokens: 5, outputTokens: 2 });
    expect((await governance().usage(actor)).summary.chargedTokens).toBe(0);
  });
  it('enforces per-user overrides and zero budgets without consuming installation quota', async () => {
    await policy({
      mode: 'enforce',
      verifiedProfile: profile,
      userOverrides: [{ userId: actor, monthlyTokens: 0, dailyTokens: 0 }],
    });
    await expect(reserve()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(reserve(other)).resolves.toBeTypeOf('string');
  });
  it('fails closed for unverified or changed model profiles, byte/token boundaries and paused admission', async () => {
    await policy({ mode: 'enforce', verifiedProfile: { ...profile, configurationRevision: 1 } });
    await expect(reserve()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    await policy({ mode: 'enforce', verifiedProfile: profile, maxInputTokens: 1 });
    await expect(reserve()).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await policy({ mode: 'paused' });
    await expect(reserve()).rejects.toMatchObject({ code: 'AI_DISABLED' });
    await policy({ maxInputBytes: 1024 });
    await expect(
      governance().reserve(
        configuration,
        0,
        { ...request, system: 'x'.repeat(1025) },
        invocation(),
      ),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });
  it('keeps missing usage conservative, prices unknown and settlement idempotent', async () => {
    const id = await reserve();
    await governance().recordEvidence(id, { inputTokens: null, outputTokens: null });
    await governance().transition(id, 'failed');
    await governance().transition(id, 'success', { inputTokens: 0, outputTokens: 0 });
    const result = (await governance().usage(actor)).attempts[0];
    if (!result) throw new Error('Missing attempt');
    expect(result.chargedTokens).toBe(result.reservedTokens);
    expect(result).toMatchObject({
      usageKind: 'conservative',
      estimatedCost: null,
      contentOutcome: 'failed',
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM audit_events WHERE action='ai.attempt_settled'",
      ).first('n'),
    ).toBe(1);
  });
  it('freezes new admission when reported usage exceeds the reservation', async () => {
    const id = await reserve();
    await governance().transition(id, 'success', { inputTokens: 100000, outputTokens: 1000 });
    await expect(reserve(other)).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect((await governance().usage(actor)).summary.chargedTokens).toBe(101000);
  });
  it('rolls back admission when its audit fails, with no upstream call', async () => {
    await env.DB.exec(
      "CREATE TRIGGER fail_ai_audit BEFORE INSERT ON audit_events WHEN NEW.action='ai.attempt_reserved' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    );
    await expect(reserve()).rejects.toThrow();
    expect(await env.DB.prepare('SELECT count(*) n FROM ai_attempts').first('n')).toBe(0);
  });
  it('retains a successful provider observation across content validation failure', async () => {
    const generate = vi.fn<AiAdapter<AbortSignal>['generate']>(async (_c, _k, _r, _s, observe) => {
      await observe?.({ inputTokens: 20, outputTokens: 10 });
      throw new DomainError({ code: 'AI_INVALID_RESPONSE', message: 'Bad JSON', httpStatus: 502 });
    });
    const ai = createAiService({
      governance: governance(),
      loadConfiguration: async () => ({ configuration, apiKey: 'synthetic', revision: 0 }),
      adapters: { openai: { generate }, anthropic: { generate }, 'workers-ai': { generate } },
    });
    await expect(ai.generate(request, { invocation: invocation() })).rejects.toMatchObject({
      code: 'AI_INVALID_RESPONSE',
    });
    expect((await governance().usage(actor)).summary.chargedTokens).toBe(30);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM ai_attempts').all())).not.toContain(
      'private synthetic prompt',
    );
  });
  it('makes manual terminal reconciliation atomic, idempotent and unable to overwrite a settled attempt', async () => {
    const id = await reserve();
    await governance().transition(id, 'unknown');
    const input = {
      ...invocation(),
      attemptId: id,
      inputTokens: 4,
      outputTokens: 3,
      evidenceReference: 'provider-ticket-synthetic',
    };
    const first = await governance().reconcile(input);
    expect(await governance().reconcile(input)).toBe(first);
    at = new Date('2026-10-16T23:59:59Z');
    expect(await governance().reconcile(input)).toBe(first);
    at = new Date('2026-10-17T00:00:00Z');
    await expect(governance().reconcile(input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(
      governance().reconcile({ ...input, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await governance().usage(actor)).summary.chargedTokens).toBe(7);
  });
  it('uses the governance clock for policy replay and expires it exactly after 24 hours', async () => {
    const input = {
      ...invocation(),
      policy: { ...DEFAULT_AI_GOVERNANCE_POLICY, monthlyTokens: 1000 },
      expectedRevision: 0,
    };
    const first = await governance().updatePolicy(input);
    at = new Date('2026-10-16T23:59:59Z');
    expect(await governance().updatePolicy(input)).toBe(first);
    await expect(
      governance().updatePolicy({ ...input, requestHash: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    at = new Date('2026-10-17T00:00:00Z');
    await expect(governance().updatePolicy(input)).rejects.toMatchObject({
      code: 'STALE_IF_MATCH',
    });
    expect((await governance().policy()).revision).toBe(1);
  });
});

describe('CAP-072 crash and late-result recovery', () => {
  it('classifies crashed submitted attempts without releasing or resubmitting them', async () => {
    await reserve();
    at = new Date('2026-10-16T00:04:00Z');
    expect(await governance().classifyStale()).toBe(1);
    expect(await governance().classifyStale()).toBe(0);
    expect((await governance().usage(actor)).summary.unknown).toBe(1);
    await expect(reserve()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('keeps known usage intact when marking a request unknown', async () => {
    const id = await reserve();
    await governance().recordEvidence(id, { inputTokens: 12, outputTokens: 3 });
    await governance().transition(id, 'unknown');
    expect(
      await env.DB.prepare('SELECT input_tokens FROM ai_attempts WHERE id=?')
        .bind(id)
        .first('input_tokens'),
    ).toBe(12);
  });
  it('settles a late uncancellable result once after the caller stops waiting', async () => {
    const base = governance();
    let release: (() => void) | undefined;
    let begin: (() => void) | undefined;
    let end: (() => void) | undefined;
    const started = new Promise<void>((r) => {
      begin = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const settled = new Promise<void>((r) => {
      end = r;
    });
    const transition: typeof base.transition = async (...args) => {
      await base.transition(...args);
      if (args[1] === 'success') end?.();
    };
    const generate: AiAdapter<AbortSignal>['generate'] = async (_c, _k, _r, _s, observe) => {
      begin?.();
      await gate;
      await observe?.({ inputTokens: 8, outputTokens: 2 });
      return {
        protocol: 'openai',
        model: 'synthetic-model',
        text: 'synthetic result',
        json: null,
        finishReason: 'stop',
        usage: { inputTokens: 8, outputTokens: 2 },
      };
    };
    const ai = createAiService({
      governance: { ...base, transition },
      loadConfiguration: async () => ({ configuration, apiKey: 'synthetic', revision: 0 }),
      adapters: { openai: { generate }, anthropic: { generate }, 'workers-ai': { generate } },
    });
    const controller = new AbortController();
    const promise = ai.generate(request, { invocation: invocation(), signal: controller.signal });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await started;
    controller.abort();
    await assertion;
    expect((await base.usage(actor)).summary.unknown).toBe(1);
    release?.();
    await settled;
    expect((await base.usage(actor)).summary).toMatchObject({ chargedTokens: 10, unknown: 0 });
  });
  it('preserves all quota and replay state when settlement audit fails', async () => {
    const id = await reserve();
    await env.DB.exec(
      "CREATE TRIGGER fail_ai_settlement BEFORE INSERT ON audit_events WHEN NEW.action='ai.attempt_settled' BEGIN SELECT RAISE(ABORT,'synthetic settlement failure'); END",
    );
    await expect(
      governance().transition(id, 'success', { inputTokens: 5, outputTokens: 2 }),
    ).rejects.toThrow();
    expect((await governance().usage(actor)).summary).toMatchObject({
      chargedTokens: 0,
      active: 1,
    });
  });
});

describe('R-API-004 terminal AI rejection recovery', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    it.each([401, 402, 429])(
      `${protocol} releases concurrency after a definite HTTP %i rejection`,
      async (status) => {
        const fetchImpl = vi.fn(async () =>
          Response.json(
            {
              error: {
                message: 'synthetic private provider response',
                type: 'invalid_request_error',
              },
            },
            { status },
          ),
        );
        const ai = createAiService({
          governance: governance(),
          loadConfiguration: async () => ({
            configuration: { ...configuration, protocol },
            apiKey: 'synthetic',
            revision: 0,
          }),
          adapters: createAiAdapters(undefined, fetchImpl),
        });
        await expect(ai.generate(request, { invocation: invocation() })).rejects.toMatchObject({
          code: 'AI_UPSTREAM_ERROR',
        });
        expect((await governance().usage(actor)).summary).toMatchObject({ active: 0, unknown: 0 });
        expect((await governance().usage(actor)).attempts[0]).toMatchObject({
          status: 'completed',
          usageKind: 'conservative',
          contentOutcome: 'failed',
        });
        await expect(reserve()).resolves.toBeTypeOf('string');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      },
    );
    it.each([408, 500])(
      `${protocol} retains unknown capacity for HTTP %i without terminal evidence`,
      async (status) => {
        const ai = createAiService({
          governance: governance(),
          loadConfiguration: async () => ({
            configuration: { ...configuration, protocol },
            apiKey: 'synthetic',
            revision: 0,
          }),
          adapters: createAiAdapters(undefined, async () =>
            Response.json({ error: { message: 'synthetic' } }, { status }),
          ),
        });
        await expect(ai.generate(request, { invocation: invocation() })).rejects.toMatchObject({
          code: 'AI_UPSTREAM_ERROR',
        });
        expect((await governance().usage(actor)).summary).toMatchObject({ active: 0, unknown: 1 });
        await expect(reserve()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      },
    );
  }
  it('does not retain capacity when the native binding is absent before submission', async () => {
    const ai = createAiService({
      governance: governance(),
      loadConfiguration: async () => ({
        configuration: { ...configuration, protocol: 'workers-ai' },
        apiKey: null,
        revision: 0,
      }),
      adapters: createAiAdapters(),
    });
    await expect(ai.generate(request, { invocation: invocation() })).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
    });
    expect((await governance().usage(actor)).summary).toMatchObject({
      chargedTokens: 0,
      active: 0,
      unknown: 0,
    });
    await expect(reserve()).resolves.toBeTypeOf('string');
  });
});
