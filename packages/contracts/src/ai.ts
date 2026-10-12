import { z } from 'zod';

export const aiProtocolSchema = z.enum(['workers-ai', 'anthropic', 'openai']);
export type AiProtocol = z.infer<typeof aiProtocolSchema>;

// HTTPS only: endpoints are admin-controlled SDK base URLs, never request inputs.
export const aiBaseUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    return /^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/.test(value);
  }, 'Use an HTTPS base URL without credentials, query or fragment');

export const aiConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    protocol: aiProtocolSchema,
    model: z.string().trim().max(200),
    baseUrl: aiBaseUrlSchema.nullable(),
    maxOutputTokens: z.number().int().min(1).max(32768),
    timeoutMs: z.number().int().min(1000).max(120000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && !value.model)
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Model is required when AI is enabled',
      });
    if (value.protocol === 'workers-ai' && value.baseUrl !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Workers AI uses the native binding',
      });
  });
export type AiConfiguration = z.infer<typeof aiConfigurationSchema>;
export const DEFAULT_AI_CONFIGURATION: AiConfiguration = {
  enabled: false,
  protocol: 'workers-ai',
  model: '',
  baseUrl: null,
  maxOutputTokens: 1024,
  timeoutMs: 30000,
};
export const updateAiConfigurationSchema = z
  .object({
    configuration: aiConfigurationSchema,
    // Omit to preserve; null explicitly clears; a string replaces. Never returned.
    apiKey: z.string().trim().min(1).max(8192).nullable().optional(),
  })
  .strict();
export type UpdateAiConfiguration = z.infer<typeof updateAiConfigurationSchema>;
export const aiConfigurationResponseSchema = z
  .object({
    configuration: aiConfigurationSchema,
    hasApiKey: z.boolean(),
    workersAiAvailable: z.boolean(),
    canManage: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type AiConfigurationResponse = z.infer<typeof aiConfigurationResponseSchema>;

export const aiGenerateRequestSchema = z
  .object({
    system: z.string().max(65536).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(65536),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    output: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('text') }).strict(),
        z
          .object({
            type: z.literal('json_schema'),
            name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            schema: z.object({ type: z.literal('object') }).catchall(z.unknown()),
          })
          .strict(),
      ])
      .default({ type: 'text' }),
  })
  .strict();
export type AiGenerateRequest = z.infer<typeof aiGenerateRequestSchema>;
export interface AiGenerateResult {
  readonly protocol: AiProtocol;
  readonly model: string;
  readonly text: string;
  readonly json: unknown | null;
  readonly finishReason: string | null;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
}
export interface AiAdapter<Signal> {
  generate(
    configuration: AiConfiguration,
    apiKey: string | null,
    request: AiGenerateRequest,
    signal: Signal,
  ): Promise<AiGenerateResult>;
}
export interface AiService<Signal> {
  generate(
    request: AiGenerateRequest,
    options?: { readonly signal?: Signal },
  ): Promise<AiGenerateResult>;
}

export const aiReplyRequestSchema = z
  .object({
    sourceMessageId: z.string().uuid().optional(),
    subject: z.string().trim().min(1).max(998),
    instructions: z.string().trim().max(4000).default(''),
    draftBody: z.string().max(16000).default(''),
    language: z.enum(['en', 'zh-CN']),
  })
  .strict();
export type AiReplyRequest = z.infer<typeof aiReplyRequestSchema>;
export const aiReplyResponseSchema = z
  .object({ text: z.string().trim().min(1).max(16000) })
  .strict();
export type AiReplyResponse = z.infer<typeof aiReplyResponseSchema>;
