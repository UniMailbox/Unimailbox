import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { ScheduledSendsPage } from './ScheduledSendsPage';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse, errorResponse } from '../../test-utils';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});
const mailbox = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
async function mount(conflict = false) {
  let item = {
    id,
    subject: 'Send later',
    fromAddress: 'me@example.com',
    fromName: '',
    isRead: 1,
    isStarred: 0,
    folder: 'scheduled',
    createdAt: new Date().toISOString(),
    recipients: { to: [{ address: 'to@example.com', displayName: '' }], cc: [] },
    scheduledAt: new Date(Date.now() + 2 * 3600_000).toISOString(),
    revision: 2,
  };
  let cancelled = false;
  const calls: { method: string; body: unknown }[] = [];
  const client = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/auth/me'))
        return jsonResponse({
          data: { user: { id: 'user', email: 'me@example.com', displayName: 'Me' } },
        });
      if (method === 'GET')
        return jsonResponse({ data: { items: cancelled ? [] : [item], nextCursor: null } });
      const body = JSON.parse(String(init?.body)) as {
        scheduledAt?: string;
        expectedRevision: number;
      };
      calls.push({ method, body });
      if (conflict) return errorResponse('SCHEDULE_STATE_CONFLICT', 'Synthetic conflict', 409);
      if (method === 'POST') cancelled = true;
      else item = { ...item, scheduledAt: body.scheduledAt ?? item.scheduledAt, revision: 3 };
      return jsonResponse({ data: { messageId: id, status: cancelled ? 'draft' : 'queued' } });
    },
  });
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/mailbox/$mailboxId',
    component: () => <ScheduledSendsPage mailboxId={mailbox} />,
  });
  const detail = createRoute({
    getParentRoute: () => root,
    path: '/mailbox/$mailboxId/messages/$messageId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, detail]),
    history: createMemoryHistory({ initialEntries: [`/mailbox/${mailbox}`] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={query}>
      <ApiClientProvider client={client}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  await screen.findByText('Send later');
  return { calls };
}

it('changes a schedule using the current revision and refetches the list', async () => {
  const { calls } = await mount();
  expect(screen.getByRole('link', { name: 'Send later' })).toHaveAttribute(
    'href',
    `/mailbox/${mailbox}/messages/${id}`,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Change time' }));
  const date = new Date(Date.now() + 3 * 3600_000);
  date.setSeconds(0, 0);
  fireEvent.input(screen.getByLabelText('Date and time'), {
    target: {
      value: new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16),
    },
  });
  await user.click(screen.getByRole('button', { name: 'Confirm schedule' }));
  await waitFor(() =>
    expect(calls).toEqual([
      { method: 'PATCH', body: { expectedRevision: 2, scheduledAt: date.toISOString() } },
    ]),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(document.querySelector('time')).toHaveAttribute('datetime', date.toISOString());
});
it('cancels once and removes the returned-to-drafts message from the pending list', async () => {
  const { calls } = await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel send' }));
  expect(await screen.findByText('No scheduled messages')).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'POST', body: { expectedRevision: 2 } }]);
});
it('keeps a conflicting task visible and displays the localized stable error', async () => {
  const { calls } = await mount(true);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel send' }));
  expect(
    await screen.findByText('The schedule changed or sending has started. Refresh and try again.'),
  ).toBeInTheDocument();
  expect(screen.getByText('Send later')).toBeInTheDocument();
  expect(calls).toHaveLength(1);
});
