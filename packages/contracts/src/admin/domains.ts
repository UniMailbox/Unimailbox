// packages/contracts/src/admin/domains.ts — CAP-066 managed-domain admin API.
// The response exposes only the selected provider connection id; provider
// credentials and connection secrets never cross this boundary.

import { z } from 'zod';
import { domainNameSchema } from '../domain-name';
import { uuidSchema } from '../ids';

export const managedDomainStatusSchema = z.enum(['active', 'disabled']);

export type ManagedDomainStatus = z.infer<typeof managedDomainStatusSchema>;

export const createManagedDomainRequestSchema = z
  .object({
    name: domainNameSchema,
  })
  .strict();

export type CreateManagedDomainRequest = z.infer<typeof createManagedDomainRequestSchema>;

/** Select or clear the provider connection used for outbound delivery. */
export const updateManagedDomainOutboundConnectionRequestSchema = z
  .object({
    connectionId: uuidSchema.nullable(),
  })
  .strict();

export type UpdateManagedDomainOutboundConnectionRequest = z.infer<
  typeof updateManagedDomainOutboundConnectionRequestSchema
>;

/** The verification action has no caller-supplied fields. */
export const verifyManagedDomainRequestSchema = z.object({}).strict();

export type VerifyManagedDomainRequest = z.infer<typeof verifyManagedDomainRequestSchema>;

export const managedDomainSchema = z
  .object({
    id: uuidSchema,
    name: domainNameSchema,
    status: managedDomainStatusSchema,
    outboundConnectionId: uuidSchema.nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type ManagedDomain = z.infer<typeof managedDomainSchema>;

export const managedDomainListResponseSchema = z
  .object({
    items: z.array(managedDomainSchema),
  })
  .strict();

export type ManagedDomainListResponse = z.infer<typeof managedDomainListResponseSchema>;

export const verifyManagedDomainResponseSchema = z
  .object({
    verified: z.literal(true),
    domain: domainNameSchema,
  })
  .strict();

export type VerifyManagedDomainResponse = z.infer<typeof verifyManagedDomainResponseSchema>;

export const updateManagedDomainOutboundConnectionResponseSchema = managedDomainSchema;

export type UpdateManagedDomainOutboundConnectionResponse = ManagedDomain;

export const deleteManagedDomainResponseSchema = z
  .object({
    id: uuidSchema,
    deleted: z.literal(true),
  })
  .strict();

export type DeleteManagedDomainResponse = z.infer<typeof deleteManagedDomainResponseSchema>;
