import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type {
  MessageDetail,
  MessageListItem,
  MessageListResponse,
  MessageThreadResponse,
} from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { jsonResponse } from '../../test-utils';
import { authQueryKeys } from '../auth/auth-queries';
import {
  mailboxCachePolicy,
  mailboxListQuery,
  mailboxMessagesInfiniteQuery,
  messageDetailQuery,
  messageThreadQuery,
  mailboxQueryKeys,
  useMarkMessageReadMutation,
  useToggleMessageStarMutation,
  useDeleteMessageMutation,
  useComposeMessageMutation,
} from './mailbox-queries';

const box = '30000000-0000-4000-8000-000000000001';
const id = '40000000-0000-4000-8000-000000000001';
const row: MessageListItem = {
  id,
  fromAddress: 'sender@example.test',
  fromName: 'Sender',
  subject: 'Synthetic',
  isRead: 0,
  isStarred: 0,
  folder: 'inbox',
  createdAt: '2026-01-01',
  recipients: { to: [], cc: [] },
};
const detail: MessageDetail = {
  ...row,
  htmlBody: '',
  textBody: 'Fixture',
  messageIdHeader: '<fixture@example.test>',
  inReplyToHeader: null,
  referencesHeader: '',
  status: 'delivered',
};
const session = (userId: string) => ({
  userId,
  email: userId + '@example.test',
  displayName: userId,
  expiresAt: '',
});
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  vi.useRealTimers();
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(authQueryKeys.session(), session('actor'));
  const paths: string[] = [];
  const api = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: async (input, init) => {
      const path = String(input);
      paths.push(path);
      if (path === '/api/v1/auth/me')
        return jsonResponse({
          data: { user: { id: 'actor', email: 'actor@example.test', displayName: 'actor' } },
        });
      if (init?.method === 'PATCH')
        return path.endsWith('/star')
          ? jsonResponse({ data: { id, isStarred: 1 } })
          : jsonResponse({ data: { ok: true } });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (init?.method === 'POST')
        return jsonResponse({ data: { messageId: id, status: 'queued' } }, 202);
      if (path.endsWith('/thread'))
        return jsonResponse({ data: { rootId: '<fixture@example.test>', items: [row] } });
      if (path.endsWith('/messages/' + id)) return jsonResponse({ data: detail });
      if (path.includes('/messages'))
        return jsonResponse({ data: { items: [row], nextCursor: null } });
      return jsonResponse({ data: { items: [] } });
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ApiClientProvider client={api}>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
  return { client, paths, wrapper };
}
it.each(['list', 'messages', 'detail', 'thread'] as const)(
  'CAP-071: %s remount reuses fresh data, expiry and explicit invalidation refetch',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date('2030-01-01T00:00:00Z');
    vi.setSystemTime(start);
    const { client, paths, wrapper } = setup();
    const mailReads = () => paths.filter((path) => path !== '/api/v1/auth/me');
    const hook = () =>
      ({
        list: mailboxListQuery,
        messages: () => mailboxMessagesInfiniteQuery(box),
        detail: () => messageDetailQuery(box, id),
        thread: () => messageThreadQuery(box, id),
      })[kind]();
    let mounted = renderHook(hook, { wrapper });
    await waitFor(() => expect(mounted.result.current.isSuccess).toBe(true));
    expect(mailReads()).toHaveLength(1);
    mounted.unmount();
    mounted = renderHook(hook, { wrapper });
    expect(mounted.result.current.data).toBeDefined();
    await act(async () => {});
    expect(mailReads()).toHaveLength(1);
    mounted.unmount();
    vi.setSystemTime(start.getTime() + mailboxCachePolicy[kind] + 1);
    mounted = renderHook(hook, { wrapper });
    await waitFor(() => expect(mailReads()).toHaveLength(2));
    await waitFor(() => expect(mounted.result.current.isFetching).toBe(false));
    const key =
      kind === 'list'
        ? mailboxQueryKeys.list('actor')
        : kind === 'messages'
          ? mailboxQueryKeys.messages(box, 'actor')
          : kind === 'detail'
            ? mailboxQueryKeys.message(box, id, 'actor')
            : mailboxQueryKeys.thread(box, id, 'actor');
    await act(async () => {
      await client.invalidateQueries({ queryKey: key, exact: true });
    });
    expect(mailReads()).toHaveLength(3);
  },
);
it('R-MESSAGE-005 R-AUTHZ-004: confirmed read/star/delete update sibling folder and thread views only for this user and mailbox', async () => {
  const { client, paths, wrapper } = setup();
  function seed(user: string, mailbox = box) {
    for (const folder of ['inbox', 'archive'] as const)
      client.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(mailbox, user, folder),
        { pages: [{ items: [row], nextCursor: null }], pageParams: [undefined] },
      );
    client.setQueryData(mailboxQueryKeys.message(mailbox, id, user), detail);
    for (const anchor of [id, 'other-anchor'])
      client.setQueryData<MessageThreadResponse>(mailboxQueryKeys.thread(mailbox, anchor, user), {
        rootId: '<fixture@example.test>',
        items: [row],
      });
  }
  seed('actor');
  const schedules = [{ id: 'synthetic-schedule' }];
  const scheduledKey = [...mailboxQueryKeys.messagesFamily(box, 'actor'), 'scheduled-sends'];
  client.setQueryData(scheduledKey, schedules);
  seed('other-user');
  seed('actor', 'other-mailbox');
  const foreign = client.getQueryData(mailboxQueryKeys.message(box, id, 'other-user'));
  const otherBox = client.getQueryData(mailboxQueryKeys.message('other-mailbox', id, 'actor'));
  const hooks = renderHook(
    () => ({
      read: useMarkMessageReadMutation(),
      star: useToggleMessageStarMutation(),
      remove: useDeleteMessageMutation(),
    }),
    { wrapper },
  );
  await act(async () => {
    await hooks.result.current.read.mutateAsync({ mailboxId: box, messageId: id });
    await hooks.result.current.star.mutateAsync({ mailboxId: box, messageId: id });
  });
  expect(
    client.getQueryData<MessageDetail>(mailboxQueryKeys.message(box, id, 'actor')),
  ).toMatchObject({ isRead: 1, isStarred: 1 });
  expect(
    client.getQueryData<MessageThreadResponse>(
      mailboxQueryKeys.thread(box, 'other-anchor', 'actor'),
    )?.items[0],
  ).toMatchObject({ isRead: 1, isStarred: 1 });
  expect(
    client.getQueryData<InfiniteData<MessageListResponse>>(
      mailboxQueryKeys.messages(box, 'actor', 'archive'),
    )?.pages[0]?.items[0],
  ).toMatchObject({ isRead: 1, isStarred: 1 });
  await act(async () => {
    await hooks.result.current.remove.mutateAsync({ mailboxId: box, messageId: id });
  });
  expect(client.getQueryData(mailboxQueryKeys.message(box, id, 'actor'))).toBeUndefined();
  expect(
    client.getQueryData<MessageThreadResponse>(
      mailboxQueryKeys.thread(box, 'other-anchor', 'actor'),
    )?.items,
  ).toEqual([]);
  expect(
    client.getQueryData<InfiniteData<MessageListResponse>>(
      mailboxQueryKeys.messages(box, 'actor', 'archive'),
    )?.pages[0]?.items,
  ).toEqual([]);
  expect(client.getQueryData(mailboxQueryKeys.message(box, id, 'other-user'))).toEqual(foreign);
  expect(client.getQueryData(mailboxQueryKeys.message('other-mailbox', id, 'actor'))).toEqual(
    otherBox,
  );
  expect(client.getQueryData(scheduledKey)).toEqual(schedules);
  expect(paths).toHaveLength(3);
});
it('CAP-071: compose invalidates fresh mail views only inside the sending account and mailbox', async () => {
  const { client, wrapper } = setup();
  for (const [user, mailbox] of [
    ['actor', box],
    ['other-user', box],
    ['actor', 'other-mailbox'],
  ])
    client.setQueryData(mailboxQueryKeys.message(mailbox ?? '', id, user), detail);
  const hook = renderHook(useComposeMessageMutation, { wrapper });
  await act(async () => {
    await hook.result.current.mutateAsync({
      mailboxId: box,
      to: ['recipient@example.test'],
      cc: [],
      subject: 'Synthetic',
      htmlBody: '',
      textBody: 'Fixture',
    });
  });
  expect(client.getQueryState(mailboxQueryKeys.message(box, id, 'actor'))?.isInvalidated).toBe(
    true,
  );
  expect(client.getQueryState(mailboxQueryKeys.message(box, id, 'other-user'))?.isInvalidated).toBe(
    false,
  );
  expect(
    client.getQueryState(mailboxQueryKeys.message('other-mailbox', id, 'actor'))?.isInvalidated,
  ).toBe(false);
});
