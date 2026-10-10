// packages/contracts/src/admin/signatures.ts — CAP-068.
// One signature belongs to one managed domain. HTML is sanitized by the
// Worker before persistence; the contract only bounds the wire payload.

import { z } from 'zod';
import { domainNameSchema } from '../domain-name';
import { uuidSchema } from '../ids';

export const SIGNATURE_CONTENT_MAX_LENGTH = 100_000;

const signatureContentSchema = z.string().max(SIGNATURE_CONTENT_MAX_LENGTH);

const signatureContentPair = {
  htmlContent: signatureContentSchema,
  textContent: signatureContentSchema,
  isEnabled: z.boolean(),
} as const;

function requireSignatureContent(
  value: { htmlContent: string; textContent: string },
  ctx: z.RefinementCtx,
): void {
  if (value.htmlContent.trim() === '' && value.textContent.trim() === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['textContent'],
      message: 'A signature must contain HTML or text content',
    });
  }
}

export const createSignatureRequestSchema = z
  .object({ domainId: uuidSchema, ...signatureContentPair })
  .strict()
  .superRefine(requireSignatureContent);

export type CreateSignatureRequest = z.infer<typeof createSignatureRequestSchema>;

export const updateSignatureRequestSchema = z
  .object(signatureContentPair)
  .strict()
  .superRefine(requireSignatureContent);

export type UpdateSignatureRequest = z.infer<typeof updateSignatureRequestSchema>;

export const signatureSchema = z
  .object({
    id: uuidSchema,
    domainId: uuidSchema,
    domainName: domainNameSchema,
    htmlContent: z.string(),
    textContent: z.string(),
    isEnabled: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type Signature = z.infer<typeof signatureSchema>;

export const signatureListResponseSchema = z.object({ items: z.array(signatureSchema) }).strict();

export type SignatureListResponse = z.infer<typeof signatureListResponseSchema>;

export const deleteSignatureResponseSchema = z
  .object({ id: uuidSchema, deleted: z.literal(true) })
  .strict();

export type DeleteSignatureResponse = z.infer<typeof deleteSignatureResponseSchema>;
