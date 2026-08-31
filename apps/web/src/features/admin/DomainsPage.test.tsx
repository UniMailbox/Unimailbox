import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { DomainsPage } from './DomainsPage';
import { adminQueryKeys } from './admin-queries';
import { errorResponse, jsonResponse, spyFetch } from '../../test-utils';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

const SESSION = {
  userId: 'u-admin',
  email: 'admin@example.com',
  displayName: 'Admin',
  expiresAt: '2099-01-01T00:00:00Z',
};

function domainRow(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `domain-${n}.example.com`,
    status: 'active',
    createdAt: '2026-08-31 00:00:00',
    updatedAt: '2026-08-31 00:00:00',
    ...overrides,
  };
}

function mountDomainsPage(resolvers: Array<(call: { url: string; method: string }) => Response>): {
  calls: Array<{ url: string; method: string; body?: string }>;
  queryClient: QueryClient;
} {
  const { fetchImpl: sequentialFetch } = spyFetch(resolvers);
  const callsWithBodies: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      return jsonResponse({
        data: {
          user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
          session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
        },
      });
    }
    const response = await sequentialFetch(input, init);
    callsWithBodies.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    return response;
  };
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: fetchImpl as typeof fetch,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), SESSION);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const domainsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/domains',
    component: DomainsPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([domainsRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin/domains'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls: callsWithBodies, queryClient };
}

describe('DomainsPage (CAP-066)', () => {
  it('renders the safe list and normalizes the add request', async () => {
    const { calls } = mountDomainsPage([
      () => jsonResponse({ data: { items: [domainRow(1)] } }),
      () => jsonResponse({ data: domainRow(2, { name: 'new.example.com' }) }, 201),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-domains-list')).toBeInTheDocument());
    expect(screen.getByText('domain-1.example.com')).toBeInTheDocument();
    expect(screen.queryByText(/outbound/i)).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Domain name'), '  NEW.EXAMPLE.COM ');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));

    await waitFor(() => expect(screen.getByText('new.example.com')).toBeInTheDocument());
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post?.body ?? '')).toEqual({ name: 'new.example.com' });
  });

  it('renders a server permission denial without retrying in a loop', async () => {
    const { calls } = mountDomainsPage([
      () => errorResponse('PERMISSION_DENIED', 'Permission denied', 403),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument());
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(1);
  });

  it('hides cached rows when a refresh shows that domain.read was revoked', async () => {
    const { queryClient } = mountDomainsPage([
      () => jsonResponse({ data: { items: [domainRow(1)] } }),
      () => errorResponse('PERMISSION_DENIED', 'Permission denied', 403),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-domain-row')).toBeInTheDocument());

    await queryClient.refetchQueries({ queryKey: adminQueryKeys.domains(SESSION.userId) });

    await waitFor(() => expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument());
    expect(screen.queryByText('domain-1.example.com')).not.toBeInTheDocument();
  });

  it('keeps the add value and exposes the stable error code after failure', async () => {
    mountDomainsPage([
      () => jsonResponse({ data: { items: [] } }),
      () => errorResponse('DOMAIN_ALREADY_MANAGED', 'A domain already exists', 409),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-domains-empty')).toBeInTheDocument());
    const user = userEvent.setup();
    const input = screen.getByLabelText('Domain name');
    await user.type(input, 'example.com');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    await waitFor(() => expect(screen.getByTestId('domain-add-error')).toBeInTheDocument());
    expect(screen.getByTestId('domain-add-error')).toHaveTextContent('DOMAIN_ALREADY_MANAGED');
    expect(input).toHaveValue('example.com');
  });

  it('requires delete confirmation and removes the row after success', async () => {
    const domain = domainRow(1);
    mountDomainsPage([
      () => jsonResponse({ data: { items: [domain] } }),
      (call) => {
        expect(call.method).toBe('DELETE');
        return jsonResponse({ data: { id: domain.id, deleted: true } });
      },
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-domain-row')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete domain-1.example.com' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent('This cannot be undone');
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    await waitFor(() => expect(screen.getByTestId('admin-domains-empty')).toBeInTheDocument());
    expect(screen.getByLabelText('Domain name')).toHaveFocus();
  });

  it('traps dialog focus and restores it to the delete trigger after Escape', async () => {
    const domain = domainRow(1);
    mountDomainsPage([() => jsonResponse({ data: { items: [domain] } })]);
    await waitFor(() => expect(screen.getByTestId('admin-domain-row')).toBeInTheDocument());
    const user = userEvent.setup();
    const deleteButton = screen.getByRole('button', { name: 'Delete domain-1.example.com' });
    await user.click(deleteButton);

    const cancel = screen.getByTestId('alert-dialog-cancel');
    const confirm = screen.getByTestId('alert-dialog-confirm');
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(deleteButton).toHaveFocus();
  });

  it('shows verify as operator confirmation and keeps the row on failure', async () => {
    const domain = domainRow(1);
    mountDomainsPage([
      () => jsonResponse({ data: { items: [domain] } }),
      () => errorResponse('DOMAIN_NOT_ACTIVE', 'Domain is disabled', 409),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-domain-row')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Verify domain-1.example.com' }));
    await waitFor(() => expect(screen.getByTestId('domain-action-error')).toBeInTheDocument());
    expect(screen.getByTestId('admin-domain-row')).toBeInTheDocument();
    expect(screen.getByTestId('domain-action-error')).toHaveTextContent('DOMAIN_NOT_ACTIVE');
  });

  it('renders an invalid response as a retryable client error', async () => {
    mountDomainsPage([() => jsonResponse({ data: { items: [{ ...domainRow(1), secret: 'x' }] } })]);
    await waitFor(() => expect(screen.getByTestId('admin-error')).toBeInTheDocument());
    expect(screen.getByTestId('admin-error-panel')).toHaveTextContent('INVALID_RESPONSE');
  });
});
