import { z } from 'zod';
import { attachmentFilenameSchema } from './attachments';
import { SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES } from './admin/settings';

// Storage ceiling only. The current system setting determines the upload limit.
export const EDITOR_FILE_MAX_BYTES = SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES;
export const EDITOR_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const editorUploadPolicySchema = z
  .object({
    maxFileBytes: z.number().int().positive().max(EDITOR_FILE_MAX_BYTES),
    maxImageBytes: z.number().int().positive().max(EDITOR_IMAGE_MAX_BYTES),
  })
  .strict();
export type EditorUploadPolicy = z.infer<typeof editorUploadPolicySchema>;
export const EDITOR_PENDING_TTL_SECONDS = 7 * 24 * 60 * 60;
export const EDITOR_BODY_MAX_BYTES = 500_000;
export const editorAssetDescriptorSchema = z
  .object({
    id: z.string().uuid(),
    filename: attachmentFilenameSchema,
    contentType: z.string(),
    sizeBytes: z.number().int().positive().max(EDITOR_FILE_MAX_BYTES),
    kind: z.enum(['image', 'file']),
    url: z.string().url(),
  })
  .strict();
export type EditorAssetDescriptor = z.infer<typeof editorAssetDescriptorSchema>;
