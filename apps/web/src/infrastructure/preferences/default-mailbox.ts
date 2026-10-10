import type { MailboxListItem } from '@unimailbox/contracts';
const key = (userId: string): string => `unimailbox:default-mailbox:${userId}`;
export function preferredMailboxId(userId: string): string | null {
  try {
    return localStorage.getItem(key(userId));
  } catch {
    return null;
  }
}
export function rememberMailbox(userId: string, mailboxId: string): void {
  try {
    localStorage.setItem(key(userId), mailboxId);
  } catch {
    /* Restricted storage still permits switching. */
  }
}
export function selectDefaultMailbox(
  items: readonly MailboxListItem[],
  user: { userId: string; email: string },
  configured?: string | null,
): MailboxListItem | undefined {
  const active = items.filter((item) => item.status === 'active');
  const saved = preferredMailboxId(user.userId);
  return (
    active.find((item) => item.id === configured) ??
    (configured === undefined ? active.find((item) => item.id === saved) : undefined) ??
    active.find((item) => item.address.toLowerCase() === user.email.toLowerCase()) ??
    active.find((item) => item.ownerUserId === user.userId) ??
    active[0]
  );
}
