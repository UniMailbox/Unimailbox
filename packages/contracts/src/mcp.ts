import { z } from 'zod';

export const mcpConfigurationSchema = z
  .object({
    enabled: z.boolean(),
    allowSend: z.boolean(),
    requestsPerMinute: z.number().int().min(1).max(120),
  })
  .strict();
export type McpConfiguration = z.infer<typeof mcpConfigurationSchema>;
export const DEFAULT_MCP_CONFIGURATION: McpConfiguration = {
  enabled: false,
  allowSend: false,
  requestsPerMinute: 30,
};
export const createMcpTokenSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    mailboxIds: z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate mailbox'),
    allowDraft: z.boolean(),
    allowSend: z.boolean(),
    expiresInDays: z.number().int().min(1).max(90),
  })
  .strict();
export type CreateMcpToken = z.infer<typeof createMcpTokenSchema>;
export const mcpTokenMetadataSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    allowDraft: z.boolean(),
    allowSend: z.boolean(),
    mailboxIds: z.array(z.string().uuid()),
    expiresAt: z.number().int(),
    revokedAt: z.number().int().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type McpTokenMetadata = z.infer<typeof mcpTokenMetadataSchema>;
export const mcpAdministrationSchema = z
  .object({
    configuration: mcpConfigurationSchema,
    revision: z.number().int().nonnegative(),
    endpoint: z.string().url(),
    canManage: z.boolean(),
    tokens: z.array(mcpTokenMetadataSchema),
    mailboxes: z.array(z.object({ id: z.string().uuid(), address: z.string() }).strict()),
  })
  .strict();
export type McpAdministration = z.infer<typeof mcpAdministrationSchema>;
export const issuedMcpTokenSchema = z
  .object({
    credential: mcpTokenMetadataSchema,
    token: z.string().nullable(),
  })
  .strict();
