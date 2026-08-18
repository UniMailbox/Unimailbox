export type UserId = string;
export type DomainId = string;
export type MailboxId = string;
export type MessageId = string;
export type AttachmentId = string;
export type SessionId = string;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const UserStatus = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  DELETED: "deleted",
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const DomainStatus = {
  ACTIVE: "active",
  DISABLED: "disabled",
} as const;
export type DomainStatus = (typeof DomainStatus)[keyof typeof DomainStatus];

export const MailboxRole = {
  VIEWER: "viewer",
  SENDER: "sender",
  ADMIN: "admin",
} as const;
export type MailboxRole = (typeof MailboxRole)[keyof typeof MailboxRole];

export const MailboxFolder = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFTS: "drafts",
  ARCHIVE: "archive",
  TRASH: "trash",
} as const;
export type MailboxFolder = (typeof MailboxFolder)[keyof typeof MailboxFolder];

export const MessageStatus = {
  DRAFT: "draft",
  QUEUED: "queued",
  SENDING: "sending",
  SENT: "sent",
  DELIVERED: "delivered",
  DELAYED: "delayed",
  BOUNCED: "bounced",
  COMPLAINED: "complained",
  FAILED: "failed",
  RECEIVED: "received",
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

export const RecipientType = {
  TO: "to",
  CC: "cc",
  BCC: "bcc",
} as const;
export type RecipientType = (typeof RecipientType)[keyof typeof RecipientType];

export const AttachmentDisposition = {
  ATTACHMENT: "attachment",
  INLINE: "inline",
} as const;
export type AttachmentDisposition =
  (typeof AttachmentDisposition)[keyof typeof AttachmentDisposition];

export type ProviderKey = string & { readonly __brand: "ProviderKey" };
export const BREVO_PROVIDER_KEY = "brevo" as ProviderKey;
export const RESEND_PROVIDER_KEY = "resend" as ProviderKey;

export function parseProviderKey(value: string): ProviderKey {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(value)) {
    throw new DomainError("INVALID_PROVIDER_KEY", "Invalid provider key");
  }
  return value as ProviderKey;
}

export const PERMISSION_KEYS = [
  "message.read",
  "message.read_all",
  "message.send",
  "message.delete",
  "attachment.read",
  "mailbox.create",
  "mailbox.manage",
  "mailbox.share",
  "user.read",
  "user.manage",
  "role.read",
  "role.manage",
  "domain.read",
  "domain.manage",
  "signature.read",
  "signature.manage",
  "settings.read",
  "settings.manage",
  "provider.sync",
  "webhook_event.read",
  "webhook_event.delete",
  "analytics.read",
  "ai.read",
  "ai.write",
  "schedule.write",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export const ADMINISTRATOR_PERMISSIONS: readonly PermissionKey[] =
  PERMISSION_KEYS;
export const MEMBER_PERMISSIONS: readonly PermissionKey[] = [
  "message.read",
  "message.send",
  "message.delete",
  "attachment.read",
  "mailbox.create",
  "mailbox.manage",
  "mailbox.share",
];

export interface Principal {
  userId: UserId;
  email: string;
  permissions: ReadonlySet<PermissionKey>;
}

export const InstallationStep = {
  ADMIN_BOOTSTRAP: "admin_bootstrap",
  COMPLETE: "complete",
} as const;

export type InstallationStep =
  (typeof InstallationStep)[keyof typeof InstallationStep];

export interface InstallationStatus {
  installationVersion: number;
  stateVersion: number;
  currentStep: InstallationStep;
  completedSteps: string[];
  recoverableError?: {
    code: string;
    message: string;
  };
}

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const PRESIGN_TTL_SECONDS = 300;

export const statusRank: Record<MessageStatus, number> = {
  draft: 0,
  queued: 10,
  sending: 20,
  sent: 30,
  delayed: 40,
  delivered: 50,
  bounced: 60,
  failed: 60,
  complained: 70,
  received: 100,
};

export interface ComposeDraft {
  id: string;
  mailboxId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  parentMessageId?: string;
  includeSignature: boolean;
  attachments: Array<{
    attachmentId: string;
    filename: string;
    size: number;
    uploadState: "pending" | "uploading" | "ready" | "failed";
  }>;
  updatedAt: number;
}
