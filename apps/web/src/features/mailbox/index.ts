// apps/web — mailbox feature public API.
//
// CAP-042 (Batch 5) AC 20. CAP-043 Slice 1 adds the list/inbox pages
// and their state-surface components. The router imports MailboxShell
// (kept as the placeholder authorized shell from Batch 5) and the new
// `MailboxListPage` / `InboxListPage` directly; the loading/error
// primitives remain reusable across the mailbox subtree (CAP-043/044).
export { MailboxShell } from './MailboxShell';
export { MailboxLoading } from './MailboxLoading';
export { MailboxError } from './MailboxError';
export type { MailboxErrorProps } from './MailboxError';
export { MailboxListPage } from './MailboxListPage';
export { InboxListPage } from './InboxListPage';
export { MailboxListSkeleton } from './MailboxListSkeleton';
export { InboxListSkeleton } from './InboxListSkeleton';
export { InboxEmpty } from './InboxEmpty';
export type { InboxListPageProps } from './InboxListPage';
// CAP-044 Slice 1: the composer. (Fix pass i: buildReplyContext /
// ReplyContext left the barrel — every consumer deep-imports
// ./reply-context, so the barrel exports were dead surface.)
export { ComposeEmail } from './ComposeEmail';
export type { ComposeEmailProps } from './ComposeEmail';
export { DraftRecoveryPage } from './DraftRecoveryPage';
export type { DraftRecoveryPageProps } from './DraftRecoveryPage';
