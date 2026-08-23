// apps/web — mailbox feature public API.
//
// The router imports MailboxShell from here. MailboxLoading and
// MailboxError are reusable across the mailbox subtree (CAP-043/044).
export { MailboxShell } from './MailboxShell';
export { MailboxLoading } from './MailboxLoading';
export { MailboxError } from './MailboxError';
export type { MailboxErrorProps } from './MailboxError';