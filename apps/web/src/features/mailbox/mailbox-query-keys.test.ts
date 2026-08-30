import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { mailboxQueryKeys } from './mailbox-queries';

describe('mailboxQueryKeys — CAP-058 per-user cache isolation', () => {
  it('uses distinct namespaces for different authenticated users across the mailbox family', () => {
    const userA = 'user-a';
    const userB = 'user-b';

    expect(mailboxQueryKeys.list(userA)).not.toEqual(mailboxQueryKeys.list(userB));
    expect(mailboxQueryKeys.messages('mailbox-1', userA)).not.toEqual(
      mailboxQueryKeys.messages('mailbox-1', userB),
    );
    expect(mailboxQueryKeys.message('mailbox-1', 'message-1', userA)).not.toEqual(
      mailboxQueryKeys.message('mailbox-1', 'message-1', userB),
    );
    expect(mailboxQueryKeys.thread('mailbox-1', 'message-1', userA)).not.toEqual(
      mailboxQueryKeys.thread('mailbox-1', 'message-1', userB),
    );
  });

  it('keeps each folder view in its own user-scoped list cache', () => {
    const inboxKey = mailboxQueryKeys.messages('mailbox-1', 'user-a', 'inbox');
    const sentKey = mailboxQueryKeys.messages('mailbox-1', 'user-a', 'sent');
    const otherUserSentKey = mailboxQueryKeys.messages('mailbox-1', 'user-b', 'sent');

    expect(inboxKey).not.toEqual(sentKey);
    expect(sentKey).not.toEqual(otherUserSentKey);
    expect(inboxKey.slice(0, -1)).toEqual(sentKey.slice(0, -1));
    expect(mailboxQueryKeys.messagesFamily('mailbox-1', 'user-a')).toEqual(inboxKey.slice(0, -1));
  });

  it('keeps authenticated targets separate from the loading/anonymous namespace', () => {
    const userId = 'user-a';
    expect(mailboxQueryKeys.messages('mailbox-1', userId)).not.toEqual(
      mailboxQueryKeys.messages('mailbox-1'),
    );
    expect(mailboxQueryKeys.message('mailbox-1', 'message-1', userId)).not.toEqual(
      mailboxQueryKeys.message('mailbox-1', 'message-1'),
    );
    expect(mailboxQueryKeys.thread('mailbox-1', 'message-1', userId)).not.toEqual(
      mailboxQueryKeys.thread('mailbox-1', 'message-1'),
    );
  });

  it('does not reuse one user cache entry when the authenticated user changes', () => {
    const queryClient = new QueryClient();
    const userAKey = mailboxQueryKeys.messages('mailbox-1', 'user-a');
    queryClient.setQueryData(userAKey, { pages: [{ items: [{ isStarred: 1 }] }] });

    expect(queryClient.getQueryData(userAKey)).toEqual({
      pages: [{ items: [{ isStarred: 1 }] }],
    });
    expect(
      queryClient.getQueryData(mailboxQueryKeys.messages('mailbox-1', 'user-b')),
    ).toBeUndefined();
  });
});
