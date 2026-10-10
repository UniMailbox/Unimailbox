// Shared wire contract for CAP-049 attachment staging.

import { z } from 'zod';

export const ATTACHMENT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 60 * 60;
export const ATTACHMENT_FILENAME_HEADER = 'X-Filename';
export const ATTACHMENT_DISPOSITION_HEADER = 'X-Attachment-Disposition';

export const attachmentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\0\r\n]/.test(value), 'Filename contains invalid characters');

const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[^\r\n;=]+=[^\r\n;]+)*$/;

export const attachmentContentTypeSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(MEDIA_TYPE_PATTERN, 'Invalid content type');

export const attachmentDispositionSchema = z.enum(['attachment', 'inline']).default('attachment');

export const attachmentUploadMetadataSchema = z
  .object({
    filename: attachmentFilenameSchema,
    contentType: attachmentContentTypeSchema,
    disposition: attachmentDispositionSchema,
  })
  .strict();

export const attachmentUploadDescriptorSchema = z
  .object({
    uploadId: z.string().uuid(),
    mailboxId: z.string().uuid(),
    filename: attachmentFilenameSchema,
    contentType: attachmentContentTypeSchema,
    disposition: attachmentDispositionSchema,
    sizeBytes: z.number().int().positive().max(ATTACHMENT_UPLOAD_MAX_BYTES),
    status: z.literal('uploaded'),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type AttachmentUploadMetadata = z.infer<typeof attachmentUploadMetadataSchema>;
export type AttachmentUploadDescriptor = z.infer<typeof attachmentUploadDescriptorSchema>;
