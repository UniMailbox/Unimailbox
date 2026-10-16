import {
  aiUsageResponseSchema,
  type AiGovernancePolicy,
  type AiInvocationContext,
  type AiUsageEvidence,
  type AiConfiguration,
  type AiGenerateRequest,
  type AuditAction,
  type AuditEventWriter,
} from '@unimailbox/contracts';
import { readGovernancePolicy, preparePolicyVersion } from './policy-repository';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import {
  sha256Hex,
  sqliteTimestamp,
  findIdempotencyRecord,
  assertSameRequestHash,
  prepareCreateIdempotencyRecord,
  isIdempotencyUniqueViolation,
} from '../../platform/idempotency';

interface Attempt {
  id: string;
  actor_user_id: string;
  status: 'submitted' | 'outcome_unknown' | 'completed';
  configuration_revision: number;
  request_hash: string;
  reserved_tokens: number;
  charged_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  policy_revision: number;
  content_outcome: 'success' | 'failed' | null;
  usage_kind: 'pending' | 'reported' | 'conservative' | 'manual';
  estimated_cost: number | null;
  currency?: string;
  created_at: string;
  completed_at: string | null;
}
const pending = () =>
  new DomainError({
    code: 'IDEMPOTENCY_REQUEST_PENDING',
    message:
      'This AI operation already exists. Its result has expired or is awaiting reconciliation.',
    httpStatus: 409,
  });
const unavailable = (message: string) =>
  new DomainError({ code: 'AI_NOT_CONFIGURED', message, httpStatus: 503 });
const limited = () =>
  new DomainError({
    code: 'RATE_LIMITED',
    message: 'AI token or concurrency budget exhausted',
    httpStatus: 429,
  });
export function createAiGovernance(db: Database, audit: AuditEventWriter, now = () => new Date()) {
  const stamp = () => sqliteTimestamp(now());
  function event(
    action: AuditAction,
    actor: string,
    id: string,
    requestId: string,
    marker?: string,
    metadata?: string,
  ): D1PreparedStatement {
    return audit.prepare(
      {
        id: crypto.randomUUID(),
        actorUserId: actor,
        action,
        resourceType: 'ai_attempt',
        resourceId: id,
        requestId,
        createdAt: stamp(),
        metadata: metadata ?? null,
      },
      marker ? { aiAttemptMarker: marker } : undefined,
    ).statement as D1PreparedStatement;
  }
  const policy = () => readGovernancePolicy(db);
  async function reserve(
    configuration: AiConfiguration,
    configurationRevision: number,
    request: AiGenerateRequest,
    invocation: AiInvocationContext,
  ) {
    const snapshot = await policy();
    const p = snapshot.policy;
    if (snapshot.blockedReason)
      throw unavailable('AI admission is paused until a new model verification is recorded');
    if (p.mode === 'paused')
      throw new DomainError({
        code: 'AI_DISABLED',
        message: 'AI admission is paused',
        httpStatus: 503,
      });
    // Budget the exact normalized request, including system and JSON schema.
    const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    if (bytes > p.maxInputBytes)
      throw new DomainError({
        code: 'BODY_TOO_LARGE',
        message: 'AI input byte budget exceeded',
        httpStatus: 413,
      });
    const profile = p.verifiedProfile;
    if (
      p.mode === 'enforce' &&
      (!profile || profile.configurationRevision !== configurationRevision)
    )
      throw unavailable(
        'Verify the token upper bound and output cap for this AI configuration before enforcement',
      );
    const inputBound = bytes + (profile?.overheadTokens ?? 1024);
    if (
      p.mode === 'enforce' &&
      (inputBound > p.maxInputTokens ||
        inputBound + configuration.maxOutputTokens > (profile?.contextTokens ?? 0))
    )
      throw new DomainError({
        code: 'BODY_TOO_LARGE',
        message: 'AI input token budget exceeded',
        httpStatus: 413,
      });
    const operationHash = await sha256Hex(`ai-reply:${invocation.idempotencyKey}`);
    const previous = await db
      .prepare('SELECT request_hash FROM ai_attempts WHERE actor_user_id=? AND operation_hash=?')
      .bind(invocation.actorUserId, operationHash)
      .first<{ request_hash: string }>();
    const legacy = await db
      .prepare(
        'SELECT request_hash FROM ai_legacy_requests WHERE actor_user_id=? AND idempotency_key=?',
      )
      .bind(invocation.actorUserId, invocation.idempotencyKey)
      .first<{ request_hash: string }>();
    if (previous || legacy) {
      if ((previous ?? legacy)?.request_hash !== invocation.requestHash)
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'AI operation input changed',
          httpStatus: 409,
        });
      throw pending();
    }
    const id = crypto.randomUUID();
    const at = stamp();
    const month = at.slice(0, 7),
      day = at.slice(0, 10);
    const override = p.userOverrides.find((x) => x.userId === invocation.actorUserId);
    const reserved = inputBound + configuration.maxOutputTokens;
    // One INSERT ... SELECT is the admission decision for all scopes. No
    // read-then-update counters; a losing decision inserts neither row nor audit.
    const insert = db
      .prepare(
        `INSERT INTO ai_attempts
      (id,actor_user_id,operation_hash,request_hash,request_id,policy_revision,configuration_revision,
       model,protocol,status,reserved_tokens,created_at,settlement_marker)
      SELECT ?,?,?,?,?,?,?,?,?,'submitted',?,?,?
      WHERE EXISTS(SELECT 1 FROM ai_configuration WHERE id='system' AND revision=?)
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
        AND EXISTS(SELECT 1 FROM ai_governance_breaker WHERE id='system' AND policy_revision=?)
        AND NOT EXISTS(SELECT 1 FROM ai_governance_breaker WHERE reason IS NOT NULL)
        AND (SELECT count(*) FROM ai_attempts WHERE status!='completed') < ?
        AND (SELECT count(*) FROM ai_attempts WHERE status!='completed' AND actor_user_id=?) < ?
        AND (?=0 OR (
          (SELECT coalesce(sum(CASE WHEN status='completed' THEN charged_tokens ELSE reserved_tokens END),0)
            FROM ai_attempts WHERE created_at>=?) + ? <= ?
          AND (SELECT coalesce(sum(CASE WHEN status='completed' THEN charged_tokens ELSE reserved_tokens END),0)
            FROM ai_attempts WHERE created_at>=? AND actor_user_id=?) + ? <= ?
          AND (SELECT coalesce(sum(CASE WHEN status='completed' THEN charged_tokens ELSE reserved_tokens END),0)
            FROM ai_attempts WHERE created_at>=?) + ? <= ?
          AND (SELECT coalesce(sum(CASE WHEN status='completed' THEN charged_tokens ELSE reserved_tokens END),0)
            FROM ai_attempts WHERE created_at>=? AND actor_user_id=?) + ? <= ?))`,
      )
      .bind(
        id,
        invocation.actorUserId,
        operationHash,
        invocation.requestHash,
        invocation.requestId,
        snapshot.revision,
        configurationRevision,
        configuration.model,
        configuration.protocol,
        reserved,
        at,
        id,
        configurationRevision,
        invocation.actorUserId,
        snapshot.revision,
        p.installationConcurrency,
        invocation.actorUserId,
        p.userConcurrency,
        p.mode === 'enforce' ? 1 : 0,
        `${month}-01 00:00:00`,
        reserved,
        p.monthlyTokens,
        `${month}-01 00:00:00`,
        invocation.actorUserId,
        reserved,
        override?.monthlyTokens ?? p.userMonthlyTokens,
        `${day} 00:00:00`,
        reserved,
        p.dailyTokens,
        `${day} 00:00:00`,
        invocation.actorUserId,
        reserved,
        override?.dailyTokens ?? p.userDailyTokens,
      );
    let result;
    try {
      result = await db.batch([
        insert,
        event('ai.attempt_reserved', invocation.actorUserId, id, invocation.requestId, id),
      ]);
    } catch (error) {
      if (
        isIdempotencyUniqueViolation(error) ||
        (error instanceof Error && error.message.includes('ai_attempts.actor_user_id'))
      )
        throw pending();
      throw error;
    }
    if (result[0]?.meta.changes !== 1) throw limited();
    return id;
  }
  async function transition(
    id: string,
    outcome: 'unknown' | 'success' | 'failed',
    evidence?: AiUsageEvidence,
    manual?: {
      actorUserId: string;
      requestId: string;
      evidenceReference: string;
      statement: D1PreparedStatement;
    },
  ) {
    const row = await db.prepare('SELECT * FROM ai_attempts WHERE id=?').bind(id).first<Attempt>();
    if (!row)
      throw new DomainError({
        code: 'NOT_FOUND',
        message: 'AI attempt not found',
        httpStatus: 404,
      });
    if (row.status === 'completed') {
      if (manual)
        throw new DomainError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'AI attempt is already settled',
          httpStatus: 409,
        });
      return;
    }
    if (outcome === 'unknown' && row.status === 'outcome_unknown') return;
    const marker = crypto.randomUUID();
    if (outcome === 'unknown') {
      await db.batch([
        db
          .prepare(
            "UPDATE ai_attempts SET status='outcome_unknown',settlement_marker=? WHERE id=? AND status='submitted'",
          )
          .bind(marker, id),
        event('ai.attempt_unknown', row.actor_user_id, id, '<internal>', marker),
      ]);
      return;
    }
    const version = await db
      .prepare(
        'SELECT input_price,output_price,currency,profile_revision FROM ai_governance_policy WHERE revision=?',
      )
      .bind(row.policy_revision)
      .first<{
        input_price: number | null;
        output_price: number | null;
        currency: string;
        profile_revision: number | null;
      }>();
    const complete = true;
    const input = evidence?.inputTokens ?? row.input_tokens;
    const output = evidence?.outputTokens ?? row.output_tokens;
    const reported = input !== null && output !== null;
    const charge = complete
      ? reported
        ? input + output
        : Math.max(row.reserved_tokens, (input ?? 0) + (output ?? 0))
      : 0;
    const metadata = manual
      ? JSON.stringify({ evidenceReference: manual.evidenceReference })
      : undefined;
    await db.batch([
      ...(manual ? [manual.statement] : []),
      db
        .prepare(
          `UPDATE ai_attempts SET status=?,content_outcome=?,charged_tokens=CASE WHEN ?=1 AND status='completed' THEN -1 ELSE ? END,input_tokens=?,output_tokens=?,
        usage_kind=?,estimated_cost=?,completed_at=?,settlement_marker=? WHERE id=? AND (?=1 OR status!='completed')`,
        )
        .bind(
          complete ? 'completed' : 'outcome_unknown',
          complete ? outcome : null,
          manual ? 1 : 0,
          charge,
          input,
          output,
          complete ? (manual ? 'manual' : reported ? 'reported' : 'conservative') : row.usage_kind,
          version?.profile_revision === row.configuration_revision &&
            input !== null &&
            output !== null &&
            version.input_price !== null &&
            version.output_price !== null
            ? (input * version.input_price + output * version.output_price) / 1_000_000
            : null,
          complete ? stamp() : null,
          marker,
          id,
          manual ? 1 : 0,
        ),
      db
        .prepare(
          `UPDATE ai_governance_breaker SET reason='usage_exceeded_reservation'
        WHERE EXISTS(SELECT 1 FROM ai_attempts WHERE settlement_marker=? AND charged_tokens>reserved_tokens)`,
        )
        .bind(marker),
      event(
        manual ? 'ai.attempt_reconciled' : complete ? 'ai.attempt_settled' : 'ai.attempt_unknown',
        manual?.actorUserId ?? row.actor_user_id,
        id,
        manual?.requestId ?? '<internal>',
        marker,
        metadata,
      ),
    ]);
  }
  async function recordEvidence(id: string, evidence: AiUsageEvidence) {
    const marker = crypto.randomUUID();
    const row = await db
      .prepare('SELECT actor_user_id,request_id FROM ai_attempts WHERE id=?')
      .bind(id)
      .first<{ actor_user_id: string; request_id: string }>();
    if (!row) return;
    await db.batch([
      db
        .prepare(
          `UPDATE ai_attempts SET input_tokens=?,output_tokens=?,provider_request_id=?,cached_input_tokens=?,reasoning_tokens=?,
        usage_kind=?,settlement_marker=? WHERE id=? AND status!='completed'`,
        )
        .bind(
          evidence.inputTokens,
          evidence.outputTokens,
          evidence.providerRequestId?.slice(0, 200) ?? null,
          evidence.cachedInputTokens ?? null,
          evidence.reasoningTokens ?? null,
          evidence.inputTokens !== null && evidence.outputTokens !== null
            ? 'reported'
            : 'conservative',
          marker,
          id,
        ),
      event('ai.usage_recorded', row.actor_user_id, id, row.request_id, marker),
    ]);
  }
  async function usage(userId?: string) {
    const { policy: p } = await policy();
    const at = now();
    const period = at.toISOString().slice(0, 7);
    const start = `${period}-01 00:00:00`,
      day = `${at.toISOString().slice(0, 10)} 00:00:00`;
    const rows = await db
      .prepare(
        `SELECT
      coalesce(sum(CASE WHEN created_at>=? AND status='completed' THEN charged_tokens ELSE 0 END),0) charged,
      coalesce(sum(CASE WHEN created_at>=? AND status='submitted' THEN reserved_tokens ELSE 0 END),0) reserved,
      coalesce(sum(CASE WHEN created_at>=? AND status='outcome_unknown' THEN reserved_tokens ELSE 0 END),0) unknown_tokens,
      coalesce(sum(CASE WHEN status='submitted' THEN 1 ELSE 0 END),0) active,
      coalesce(sum(CASE WHEN status='outcome_unknown' THEN 1 ELSE 0 END),0) unknown_count,
      coalesce(sum(CASE WHEN created_at>=? THEN CASE WHEN status='completed' THEN charged_tokens ELSE reserved_tokens END ELSE 0 END),0) daily
      FROM ai_attempts WHERE (created_at>=? OR status!='completed') ${userId ? 'AND actor_user_id=?' : ''}`,
      )
      .bind(start, start, start, day, start, ...(userId ? [userId] : []))
      .first<{
        charged: number;
        reserved: number;
        unknown_tokens: number;
        active: number;
        unknown_count: number;
        daily: number;
      }>();
    const attempts = (
      await db
        .prepare(
          `SELECT a.*,p.currency FROM ai_attempts a JOIN ai_governance_policy p ON p.revision=a.policy_revision ${userId ? 'WHERE actor_user_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 20`,
        )
        .bind(...(userId ? [userId] : []))
        .all<Attempt>()
    ).results;
    const override = p.userOverrides.find((x) => x.userId === userId);
    const monthlyLimit = userId
      ? (override?.monthlyTokens ?? p.userMonthlyTokens)
      : p.monthlyTokens;
    const dailyLimit = userId ? (override?.dailyTokens ?? p.userDailyTokens) : p.dailyTokens;
    return aiUsageResponseSchema.parse({
      summary: {
        period,
        resetsAt: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString(),
        chargedTokens: rows?.charged ?? 0,
        reservedTokens: rows?.reserved ?? 0,
        unknownTokens: rows?.unknown_tokens ?? 0,
        active: rows?.active ?? 0,
        unknown: rows?.unknown_count ?? 0,
        monthlyLimit,
        dailyLimit,
        dailyUsed: rows?.daily ?? 0,
        remainingTokens: Math.max(
          0,
          monthlyLimit - (rows?.charged ?? 0) - (rows?.reserved ?? 0) - (rows?.unknown_tokens ?? 0),
        ),
        mode: p.mode,
      },
      attempts: attempts.map((r) => ({
        id: r.id,
        actorUserId: r.actor_user_id,
        status: r.status,
        contentOutcome: r.content_outcome,
        reservedTokens: r.reserved_tokens,
        chargedTokens: r.charged_tokens,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        usageKind: r.usage_kind,
        estimatedCost: r.estimated_cost,
        currency: r.currency,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      })),
    });
  }
  async function updatePolicy(
    input: { policy: AiGovernancePolicy; expectedRevision: number } & AiInvocationContext,
  ) {
    const operation = 'PUT /api/v1/admin/ai-governance';
    const replay = async () => {
      const row = await findIdempotencyRecord(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
      );
      if (!row) return null;
      assertSameRequestHash(row, input.requestHash);
      return row.responseJson;
    };
    const stored = await replay();
    if (stored) return stored;
    const current = await policy();
    if (input.expectedRevision !== current.revision)
      throw new DomainError({
        code: 'STALE_IF_MATCH',
        message: 'Reload AI governance',
        httpStatus: 412,
      });
    const clearsBreaker =
      input.policy.mode === 'enforce' &&
      !!input.policy.verifiedProfile &&
      input.policy.verifiedProfile.verificationReference !==
        current.policy.verifiedProfile?.verificationReference;
    const json = JSON.stringify({
      data: {
        policy: input.policy,
        revision: current.revision + 1,
        canManage: true,
        blockedReason: clearsBreaker ? null : current.blockedReason,
      },
    });
    try {
      await db.batch([
        prepareCreateIdempotencyRecord(db, {
          id: crypto.randomUUID(),
          actorId: input.actorUserId,
          operation,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          responseStatus: 200,
          responseJson: json,
          createdAt: stamp(),
        }),
        ...preparePolicyVersion(db, input.policy, current.revision + 1),
        db
          .prepare(
            "UPDATE ai_governance_breaker SET policy_revision=CASE WHEN policy_revision=? THEN ? ELSE -1 END,reason=CASE WHEN ?=1 THEN NULL ELSE reason END WHERE id='system'",
          )
          .bind(input.expectedRevision, current.revision + 1, clearsBreaker ? 1 : 0),
        event(
          'ai.governance_updated',
          input.actorUserId,
          'system',
          input.requestId,
          undefined,
          JSON.stringify({ revision: current.revision + 1, mode: input.policy.mode }),
        ),
      ]);
    } catch (error) {
      const winner = await replay();
      if (winner) return winner;
      if (error instanceof Error && error.message.includes('revision'))
        throw new DomainError({
          code: 'STALE_IF_MATCH',
          message: 'Reload AI governance',
          httpStatus: 412,
        });
      throw error;
    }
    return json;
  }
  async function reconcile(
    input: AiInvocationContext & {
      attemptId: string;
      inputTokens: number | null;
      outputTokens: number | null;
      evidenceReference: string;
    },
  ) {
    const operation = `POST /api/v1/admin/ai-governance/attempts/${input.attemptId}/reconcile`;
    const replay = async () => {
      const row = await findIdempotencyRecord(
        db,
        input.actorUserId,
        operation,
        input.idempotencyKey,
      );
      if (!row) return null;
      assertSameRequestHash(row, input.requestHash);
      return row.responseJson;
    };
    const stored = await replay();
    if (stored) return stored;
    const responseJson = JSON.stringify({ data: { id: input.attemptId, reconciled: true } });
    try {
      await transition(input.attemptId, 'failed', input, {
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        evidenceReference: input.evidenceReference,
        statement: prepareCreateIdempotencyRecord(db, {
          id: crypto.randomUUID(),
          actorId: input.actorUserId,
          operation,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          responseStatus: 200,
          responseJson,
          createdAt: stamp(),
        }),
      });
    } catch (error) {
      const winner = await replay();
      if (winner) return winner;
      throw error;
    }
    return responseJson;
  }
  async function classifyStale() {
    const cutoff = sqliteTimestamp(new Date(now().getTime() - 180_000));
    const rows = (
      await db
        .prepare(
          "SELECT id,usage_kind FROM ai_attempts WHERE status!='completed' AND (status='submitted' OR usage_kind!='pending') AND created_at<? ORDER BY created_at LIMIT 100",
        )
        .bind(cutoff)
        .all<{ id: string; usage_kind: string }>()
    ).results;
    for (const row of rows)
      await transition(row.id, row.usage_kind === 'pending' ? 'unknown' : 'failed');
    return rows.length;
  }
  return {
    policy,
    reserve,
    recordEvidence,
    transition,
    usage,
    updatePolicy,
    reconcile,
    classifyStale,
  };
}
export type AiGovernance = ReturnType<typeof createAiGovernance>;
