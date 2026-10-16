import { aiGovernancePolicySchema, type AiGovernancePolicy } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

const columns = [
  'mode',
  'monthly_tokens',
  'daily_tokens',
  'user_monthly_tokens',
  'user_daily_tokens',
  'installation_concurrency',
  'user_concurrency',
  'max_input_bytes',
  'max_input_tokens',
  'profile_revision',
  'context_tokens',
  'overhead_tokens',
  'verification_reference',
  'input_price',
  'output_price',
  'currency',
] as const;
interface PolicyRow {
  revision: number;
  mode: string;
  monthly_tokens: number;
  daily_tokens: number;
  user_monthly_tokens: number;
  user_daily_tokens: number;
  installation_concurrency: number;
  user_concurrency: number;
  max_input_bytes: number;
  max_input_tokens: number;
  profile_revision: number | null;
  context_tokens: number | null;
  overhead_tokens: number | null;
  verification_reference: string | null;
  input_price: number | null;
  output_price: number | null;
  currency: string;
  reason: string | null;
}
export async function readGovernancePolicy(db: Database) {
  const row = await db
    .prepare(
      `SELECT p.*,b.reason FROM ai_governance_policy p JOIN ai_governance_breaker b ON b.policy_revision=p.revision WHERE b.id='system'`,
    )
    .first<PolicyRow>();
  if (!row) throw new Error('AI governance migration is missing');
  const overrides = (
    await db
      .prepare(
        'SELECT user_id AS userId,monthly_tokens AS monthlyTokens,daily_tokens AS dailyTokens FROM ai_user_limits WHERE policy_revision=? ORDER BY user_id',
      )
      .bind(row.revision)
      .all()
  ).results;
  const policy = aiGovernancePolicySchema.parse({
    mode: row.mode,
    monthlyTokens: row.monthly_tokens,
    dailyTokens: row.daily_tokens,
    userMonthlyTokens: row.user_monthly_tokens,
    userDailyTokens: row.user_daily_tokens,
    installationConcurrency: row.installation_concurrency,
    userConcurrency: row.user_concurrency,
    maxInputBytes: row.max_input_bytes,
    maxInputTokens: row.max_input_tokens,
    verifiedProfile:
      row.profile_revision === null
        ? null
        : {
            configurationRevision: row.profile_revision,
            contextTokens: row.context_tokens,
            overheadTokens: row.overhead_tokens,
            verificationReference: row.verification_reference,
          },
    inputPricePerMillion: row.input_price,
    outputPricePerMillion: row.output_price,
    currency: row.currency,
    userOverrides: overrides,
  });
  return { policy, revision: row.revision, blockedReason: row.reason };
}
export function preparePolicyVersion(
  db: Database,
  p: AiGovernancePolicy,
  revision: number,
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `INSERT INTO ai_governance_policy(revision,${columns.join(',')}) VALUES (${Array(17).fill('?').join(',')})`,
      )
      .bind(
        revision,
        p.mode,
        p.monthlyTokens,
        p.dailyTokens,
        p.userMonthlyTokens,
        p.userDailyTokens,
        p.installationConcurrency,
        p.userConcurrency,
        p.maxInputBytes,
        p.maxInputTokens,
        p.verifiedProfile?.configurationRevision ?? null,
        p.verifiedProfile?.contextTokens ?? null,
        p.verifiedProfile?.overheadTokens ?? null,
        p.verifiedProfile?.verificationReference ?? null,
        p.inputPricePerMillion,
        p.outputPricePerMillion,
        p.currency,
      ),
  ];
  for (let offset = 0; offset < p.userOverrides.length; offset += 20) {
    const rows = p.userOverrides.slice(offset, offset + 20);
    statements.push(
      db
        .prepare(
          `INSERT INTO ai_user_limits(policy_revision,user_id,monthly_tokens,daily_tokens) VALUES ${rows.map(() => '(?,?,?,?)').join(',')}`,
        )
        .bind(...rows.flatMap((r) => [revision, r.userId, r.monthlyTokens, r.dailyTokens])),
    );
  }
  return statements;
}
