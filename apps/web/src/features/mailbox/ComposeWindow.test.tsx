// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  Link,
} from '@tanstack/react-router';
import { ComposeWindowProvider, useComposer } from './compose-window-context';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { authQueryKeys } from '../auth/auth-queries';
afterEach(cleanup);
beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  });
});
const session = { userId: 'user-a', email: 'a@example.com', displayName: 'A', expiresAt: '' };
const mailboxes = ['a', 'b'].map((id) => ({
  id,
  address: `${id}@example.com`,
  displayName: id,
  localPart: id,
  domainId: 'domain',
  ownerUserId: 'user-a',
  status: 'active',
  createdAt: '2026-10-07 00:00:00',
}));
function Page() {
  const composer = useComposer();
  return (
    <>
      <button onClick={() => composer?.open({ mailboxId: 'a' })}>Compose</button>
      <Link to="/mailbox/b">Other mailbox</Link>
      <button onClick={() => composer?.open({ mailboxId: 'b' })}>Compose from B</button>
    </>
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(authQueryKeys.session(), session);
  const root = createRootRoute({
    component: () => (
      <ComposeWindowProvider>
        <Outlet />
      </ComposeWindowProvider>
    ),
  });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/mailbox/$mailboxId',
    component: Page,
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/mailbox/a'] }),
  });
  const fetch = async <T,>(path: string): Promise<T> => {
    let response: unknown;
    if (path === '/api/v1/auth/me')
      response = { data: { user: { id: session.userId, email: session.email, displayName: 'A' } } };
    else if (path === '/api/v1/editor-assets/policy')
      response = { data: { maxFileBytes: 104857600, maxImageBytes: 5242880 } };
    else if (path === '/api/v1/mailboxes') response = { data: { items: mailboxes } };
    else if (path.endsWith('/messages/send'))
      response = { data: { messageId: '00000000-0000-4000-8000-000000000001', status: 'queued' } };
    else throw new Error(`Unexpected API ${path}`);
    return response as T;
  };
  render(
    <QueryClientProvider client={client}>
      <ApiClientProvider client={{ baseUrl: '', fetch }}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { client, router };
}
it('keeps the same draft through fullscreen, bottom-right docking, mailbox navigation and hide/reopen', async () => {
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Compose$/ }));
  const to = await screen.findByLabelText('To');
  fireEvent.change(to, { target: { value: 'recipient@example.com' } });
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Keep my draft' } });
  const body = screen.getByRole('textbox', { name: 'Body' });
  body.focus();
  await user.type(body, 'Draft text', { skipClick: true });
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  await user.click(screen.getByRole('button', { name: 'Zoom out' }));
  expect(screen.getByRole('dialog')).toHaveClass('compose-window-docked');
  expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-modal', 'true');
  await user.click(screen.getByRole('link', { name: 'Other mailbox' }));
  expect(screen.getByLabelText('Subject')).toHaveValue('Keep my draft');
  expect(screen.getByRole('textbox', { name: 'Body' })).toBe(body);
  await user.click(screen.getByRole('button', { name: 'Hide compose' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Compose from B' }));
  expect(screen.getByLabelText('To')).toBe(to);
  expect(screen.getByRole('textbox', { name: 'Body' })).toHaveTextContent('Draft text');
  expect(screen.getByText('From: a@example.com')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Discard draft' }));
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Subject')).toHaveValue('Keep my draft');
  await user.click(screen.getByRole('button', { name: 'Discard draft' }));
  await user.click(screen.getByRole('button', { name: 'Discard message' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Compose from B' }));
  expect(await screen.findByLabelText('Subject')).toHaveValue('');
  expect(screen.getByText('From: b@example.com')).toBeInTheDocument();
});
it('removes the mounted private draft on account change', async () => {
  const { client } = mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Compose$/ }));
  fireEvent.change(await screen.findByLabelText('Subject'), { target: { value: 'Private draft' } });
  client.setQueryData(authQueryKeys.session(), null);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('releases a successfully sent draft so the next mailbox opens a fresh composer', async () => {
  mount();
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Compose$/ }));
  fireEvent.change(await screen.findByLabelText('To'), { target: { value: 'to@example.com' } });
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Send once' } });
  await user.click(screen.getByRole('button', { name: /^Send$/ }));
  expect(await screen.findByText('Message queued for sending.')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Compose from B' }));
  expect(await screen.findByLabelText('Subject')).toHaveValue('');
  expect(screen.getByText('From: b@example.com')).toBeInTheDocument();
});
