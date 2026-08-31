// packages/contracts/src/admin/domains.ts — CAP-066 managed-domain admin API.
// The response deliberately excludes outbound_connection_id and all future
// provider credential material from the admin browser surface.

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

/** The verification action has no caller-supplied fields. */
export const verifyManagedDomainRequestSchema = z.object({}).strict();

export type VerifyManagedDomainRequest = z.infer<typeof verifyManagedDomainRequestSchema>;

export const managedDomainSchema = z
  .object({
    id: uuidSchema,
    name: domainNameSchema,
    status: managedDomainStatusSchema,
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

export const deleteManagedDomainResponseSchema = z
  .object({
    id: uuidSchema,
    deleted: z.literal(true),
  })
  .strict();

export type DeleteManagedDomainResponse = z.infer<typeof deleteManagedDomainResponseSchema>;
