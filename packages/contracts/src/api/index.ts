import { z } from "zod";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  type PermissionKey,
} from "../domain";

export * from "./common/endpoint";
export * from "./common/envelope";
export * from "./common/errors";
export * from "./common/pagination";
export * from "./agent-tokens";
export * from "./auth";
export * from "./attachments";
export * from "./administration";
export * from "./drafts";
export * from "./endpoints";
export * from "./mailboxes";
export * from "./messages";

export interface ApiSuccess<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    params?: unknown;
    requestId?: string;
  };
}

export type ApiResult<T> = ApiSuccess<T> | ApiErrorBody;

const AddressSchema = z
  .string()
  .trim()
  .email()
  .transform((value) => value.toLowerCase());

export const SendMessageSchema = z.object({
  mailboxId: z.string().uuid(),
  to: z.array(AddressSchema).min(1).max(100),
  cc: z.array(AddressSchema).max(100).default([]),
  bcc: z.array(AddressSchema).max(100).default([]),
  subject: z.string().max(998).default(""),
  html: z.string().max(2_000_000).default(""),
  text: z.string().max(2_000_000).default(""),
  parentMessageId: z.string().uuid().optional(),
  includeSignature: z.boolean().default(true),
  attachmentIds: z
    .array(z.string().uuid())
    .max(MAX_ATTACHMENTS_PER_MESSAGE)
    .default([]),
});

export type SendMessageInput = z.infer<typeof SendMessageSchema>;

export const DraftMessageSchema = SendMessageSchema.extend({
  to: z.array(AddressSchema).max(100).default([]),
});

export type DraftMessageInput = z.infer<typeof DraftMessageSchema>;

export const CreateAttachmentUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
});

export type CreateAttachmentUploadInput = z.infer<
  typeof CreateAttachmentUploadSchema
>;

export interface AttachmentUpload {
  attachmentId: string;
  objectKey: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  expiresAt: string;
}

export const MailboxCreateSchema = z.object({
  localPart: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i),
  domainId: z.string().uuid(),
  displayName: z.string().trim().max(120).default(""),
});

export const ProviderConnectionSchema = z.object({
  providerKey: z.string().min(2).max(32),
  label: z.string().trim().min(1).max(80),
  apiKey: z.string().min(8),
  webhookSecret: z.string().min(8),
});

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Response body of `GET /api/v1/auth/session`. This is the only thing the web
 * client is allowed to base access decisions on — it is derived from a verified
 * access token, so a tampered client cannot widen it.
 */
/**
 * The permission the Worker asserts for the primary listing behind each
 * `/admin/<resource>` screen. The web client uses this to avoid rendering a
 * console page that can only ever return 403. Keep each entry aligned with the
 * matching `assertPermission` call in
 * `apps/worker/src/modules/administration/index.ts`; the contract test in
 * `packages/contracts/test/session.test.ts` pins the key set.
 */
export const ADMIN_RESOURCE_PERMISSIONS = {
  messages: "message.read_all",
  attachments: "attachment.read",
  users: "user.read",
  roles: "role.read",
  domains: "domain.read",
  signatures: "signature.read",
  settings: "settings.read",
  "provider-connections": "domain.read",
  "webhook-events": "webhook_event.read",
  "audit-events": "analytics.read",
  analytics: "analytics.read",
} as const satisfies Record<string, PermissionKey>;

export type AdminResourceKey = keyof typeof ADMIN_RESOURCE_PERMISSIONS;

const ADMIN_CONSOLE_ENTRY_ORDER: readonly AdminResourceKey[] = [
  "users",
  "messages",
  "attachments",
  "roles",
  "domains",
  "signatures",
  "settings",
  "provider-connections",
  "webhook-events",
  "audit-events",
  "analytics",
];

export function adminConsoleEntryResource(
  permissions: readonly PermissionKey[],
): AdminResourceKey | null {
  const granted = new Set<string>(permissions);
  return (
    ADMIN_CONSOLE_ENTRY_ORDER.find((resource) =>
      granted.has(ADMIN_RESOURCE_PERMISSIONS[resource]),
    ) ?? null
  );
}

/**
 * True when the principal can open at least one administration console page.
 * Used to decide whether the "Administration" entry point is reachable at all.
 */
export function canOpenAdminConsole(
  permissions: readonly PermissionKey[],
): boolean {
  return adminConsoleEntryResource(permissions) !== null;
}
