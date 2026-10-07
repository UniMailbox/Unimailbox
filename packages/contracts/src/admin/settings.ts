// packages/contracts/src/admin/settings.ts — CAP-069.
//
// The API exposes a typed projection over the existing system_settings
// key/value table. The closed shape is deliberate: provider credentials,
// blocklists, and future legacy settings must not leak through a generic
// settings endpoint.

import { z } from 'zod';

/** Attachment size is stored as bytes on the wire, while the admin UI edits it as value + unit. */
export const SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const siteTitleSchema = z.string().trim().min(1).max(100);
const retentionDaysSchema = z.number().int().min(1).max(3650);
const retentionHoursSchema = z.number().int().min(1).max(168);

export const systemSettingsSchema = z
  .object({
    siteTitle: siteTitleSchema,
    registrationEnabled: z.boolean(),
    inboundEnabled: z.boolean(),
    outboundEnabled: z.boolean(),
    unknownRecipientPolicy: z.enum(['reject', 'store']),
    maxMailboxesPerUser: z.number().int().min(1).max(100),
    maxAttachmentsPerMessage: z.number().int().min(1).max(10),
    maxAttachmentBytes: z.number().int().min(1).max(SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES),
    auditRetentionDays: retentionDaysSchema,
    idempotencyRetentionHours: retentionHoursSchema,
  })
  .strict();

export type SystemSettings = z.infer<typeof systemSettingsSchema>;

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  siteTitle: 'UniMailbox',
  registrationEnabled: false,
  inboundEnabled: true,
  outboundEnabled: true,
  unknownRecipientPolicy: 'reject',
  maxMailboxesPerUser: 10,
  maxAttachmentsPerMessage: 10,
  maxAttachmentBytes: SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES,
  auditRetentionDays: 90,
  idempotencyRetentionHours: 24,
};

export const updateSystemSettingsRequestSchema = systemSettingsSchema;
export type UpdateSystemSettingsRequest = z.infer<typeof updateSystemSettingsRequestSchema>;

export const systemSettingsResponseSchema = z
  .object({
    settings: systemSettingsSchema,
    environment: z.string().trim().min(1).max(32),
    canManage: z.boolean(),
    updatedAt: z.string().min(1),
  })
  .strict();

export type SystemSettingsResponse = z.infer<typeof systemSettingsResponseSchema>;
