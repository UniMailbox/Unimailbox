import { z } from 'zod';

const tokens = z.number().int().min(0).max(1_000_000_000);
const userLimit = z
  .object({
    userId: z.string().uuid(),
    monthlyTokens: tokens,
    dailyTokens: tokens,
  })
  .strict();
export const aiGovernancePolicySchema = z
  .object({
    mode: z.enum(['observe', 'enforce', 'paused']),
    monthlyTokens: tokens,
    dailyTokens: tokens,
    userMonthlyTokens: tokens,
    userDailyTokens: tokens,
    installationConcurrency: z.number().int().min(1).max(32),
    userConcurrency: z.number().int().min(1).max(8),
    maxInputBytes: z.number().int().min(1024).max(262144),
    maxInputTokens: z.number().int().min(1).max(262144),
    // Operator evidence is bound to an exact AI configuration revision. No
    // built-in certificate claims an arbitrary compatible provider is bounded.
    verifiedProfile: z
      .object({
        configurationRevision: z.number().int().min(0),
        contextTokens: z.number().int().min(1024).max(2_000_000),
        overheadTokens: z.number().int().min(1024).max(65536),
        verificationReference: z.string().trim().min(8).max(200),
      })
      .strict()
      .nullable(),
    inputPricePerMillion: z.number().nonnegative().max(10000).nullable(),
    outputPricePerMillion: z.number().nonnegative().max(10000).nullable(),
    currency: z.enum(['USD', 'CNY']),
    userOverrides: z.array(userLimit).max(100),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (new Set(policy.userOverrides.map((x) => x.userId)).size !== policy.userOverrides.length)
      ctx.addIssue({ code: 'custom', path: ['userOverrides'], message: 'Duplicate user limit' });
    if (policy.mode === 'enforce' && !policy.verifiedProfile)
      ctx.addIssue({
        code: 'custom',
        path: ['verifiedProfile'],
        message: 'Verified model profile required',
      });
  });
export type AiGovernancePolicy = z.infer<typeof aiGovernancePolicySchema>;
export const DEFAULT_AI_GOVERNANCE_POLICY: AiGovernancePolicy = {
  mode: 'observe',
  monthlyTokens: 1_000_000,
  dailyTokens: 250_000,
  userMonthlyTokens: 100_000,
  userDailyTokens: 25_000,
  installationConcurrency: 4,
  userConcurrency: 1,
  maxInputBytes: 65536,
  maxInputTokens: 32768,
  verifiedProfile: null,
  inputPricePerMillion: null,
  outputPricePerMillion: null,
  currency: 'USD',
  userOverrides: [],
};
export const aiGovernanceSnapshotSchema = z
  .object({
    policy: aiGovernancePolicySchema,
    revision: z.number().int().nonnegative(),
    canManage: z.boolean(),
    blockedReason: z.string().nullable(),
  })
  .strict();
const count = z.number().int().nonnegative().safe();
export const aiUsageSummarySchema = z
  .object({
    period: z.string(),
    resetsAt: z.string(),
    chargedTokens: count,
    reservedTokens: count,
    unknownTokens: count,
    active: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    monthlyLimit: tokens,
    dailyLimit: tokens,
    dailyUsed: count,
    remainingTokens: count,
    mode: z.enum(['observe', 'enforce', 'paused']),
  })
  .strict();
export const aiAttemptSummarySchema = z
  .object({
    id: z.string().uuid(),
    actorUserId: z.string().uuid(),
    status: z.enum(['submitted', 'outcome_unknown', 'completed']),
    contentOutcome: z.enum(['success', 'failed']).nullable(),
    reservedTokens: count,
    chargedTokens: count,
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    usageKind: z.enum(['reported', 'conservative', 'pending', 'manual']),
    estimatedCost: z.number().nonnegative().nullable(),
    currency: z.enum(['USD', 'CNY']),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .strict();
export const aiUsageResponseSchema = z
  .object({
    summary: aiUsageSummarySchema,
    attempts: z.array(aiAttemptSummarySchema).max(20),
  })
  .strict();
export const reconcileAiAttemptSchema = z
  .object({
    confirmedTerminal: z.literal(true),
    evidenceReference: z.string().trim().min(8).max(200),
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
  })
  .strict();
export type AiUsageResponse = z.infer<typeof aiUsageResponseSchema>;
export interface AiInvocationContext {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly requestId: string;
}
export interface AiUsageEvidence {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly providerRequestId?: string | null;
}
