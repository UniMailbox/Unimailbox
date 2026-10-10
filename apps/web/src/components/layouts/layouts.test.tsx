import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminLayout } from './AdminLayout';
import { MailboxLayout } from './MailboxLayout';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../../features/auth/auth-queries';

afterEach(() => {
  cleanup();
});

async function renderLayout(element: React.ReactElement, session: unknown = null): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), session);
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ data: null }), { status: 401 })) as typeof fetch,
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => element,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe('application layouts (CAP-A2)', () => {
  it('provides an independent admin navigation surface around page content', async () => {
    await renderLayout(
      <AdminLayout>
        <div data-testid="admin-content">Admin content</div>
      </AdminLayout>,
    );

    expect(screen.getByTestId('admin-layout')).toBeInTheDocument();
    expect(screen.getByTestId('admin-content')).toBeInTheDocument();
    expect(
      screen.getByRole('navigation', { name: 'Administration navigation' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByRole('link', { name: 'Back to mailbox' })).toHaveAttribute(
      'href',
      '/mailbox',
    );
    expect(screen.queryByTestId('logout-button')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByTestId('logout-button')).toBeInTheDocument();
  });

  it('keeps mailbox navigation separate from administration navigation', async () => {
    await renderLayout(
      <MailboxLayout>
        <div data-testid="mailbox-content">Mailbox content</div>
      </MailboxLayout>,
    );

    expect(screen.getByTestId('mailbox-layout')).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-content')).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Mailbox navigation' });
    expect(navigation).toBeInTheDocument();
    expect(within(navigation).queryByRole('link', { name: 'All mailboxes' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Switch mailbox' }));
    expect(await screen.findByRole('menuitem', { name: 'All mailboxes' })).toHaveAttribute(
      'href',
      '/mailboxes',
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('logout-button')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByTestId('logout-button')).toBeInTheDocument();
  });
});
