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
import { SignaturesPage } from './SignaturesPage';
import { adminQueryKeys } from './admin-queries';
import { errorResponse, jsonResponse } from '../../test-utils';

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
const DOMAIN_ID = '00000000-0000-4000-8000-000000000001';
const SIGNATURE_ID = '00000000-0000-4000-8000-000000000002';

function signature(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SIGNATURE_ID,
    domainId: DOMAIN_ID,
    domainName: 'example.com',
    htmlContent: '<p>Regards</p>',
    textContent: 'Regards',
    isEnabled: true,
    createdAt: '2026-09-01 00:00:00',
    updatedAt: '2026-09-01 00:00:00',
    ...overrides,
  };
}

function mountPage(handler: (url: string, init?: RequestInit) => Response): {
  queryClient: QueryClient;
  calls: Array<{ url: string; method: string; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    if (url.includes('/api/v1/auth/better/get-session')) {
      return jsonResponse({
        data: {
          user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
          session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
        },
      });
    }
    return handler(url, init);
  };
  const apiClient = createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), SESSION);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/signatures',
    component: SignaturesPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/admin/signatures'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { queryClient, calls };
}

describe('SignaturesPage (CAP-068)', () => {
  it('renders existing signatures and sends a strict create request', async () => {
    const created = signature({
      id: '00000000-0000-4000-8000-000000000003',
      domainName: 'new.example.com',
      domainId: '00000000-0000-4000-8000-000000000004',
    });
    const { calls } = mountPage((url, init) => {
      if (url.endsWith('/admin/signatures') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({ data: { items: [signature()] } });
      }
      if (url.endsWith('/admin/domains')) {
        return jsonResponse({
          data: {
            items: [
              {
                id: created.domainId,
                name: created.domainName,
                status: 'active',
                createdAt: created.createdAt,
                updatedAt: created.updatedAt,
              },
            ],
          },
        });
      }
      return jsonResponse({ data: created }, 201);
    });
    await waitFor(() => expect(screen.getByTestId('admin-signature-row')).toBeInTheDocument());
    expect(screen.getByTestId('signature-safety-note')).toHaveTextContent('not previewed');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Managed domain'), created.domainId as string);
    await user.type(
      screen.getByLabelText('Plain-text content', { selector: '#signature-text-create' }),
      'New regards',
    );
    await user.click(screen.getByRole('button', { name: 'Add signature' }));
    await waitFor(() =>
      expect(screen.getByText('Created the signature for new.example.com.')).toBeInTheDocument(),
    );
    const post = calls.find((call) => call.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse(post?.body ?? '')).toMatchObject({
      domainId: created.domainId,
      htmlContent: '',
      textContent: 'New regards',
      isEnabled: true,
    });
  });

  it('renders a server permission denial without stale cached data', async () => {
    const { queryClient } = mountPage((url) =>
      url.endsWith('/admin/signatures')
        ? errorResponse('PERMISSION_DENIED', 'Permission denied', 403)
        : jsonResponse({ data: { items: [] } }),
    );
    queryClient.setQueryData(adminQueryKeys.signatures(SESSION.userId), [signature()]);
    await waitFor(() => expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument());
    expect(screen.queryByTestId('admin-signature-row')).not.toBeInTheDocument();
  });

  it('wraps a schema-invalid response as a retryable client error', async () => {
    mountPage((url) =>
      url.endsWith('/admin/signatures')
        ? jsonResponse({ data: { items: [{ id: 'not-a-signature' }] } })
        : jsonResponse({ data: { items: [] } }),
    );
    await waitFor(() => expect(screen.getByTestId('admin-error')).toBeInTheDocument());
    expect(screen.getByTestId('admin-error-panel')).toHaveTextContent('INVALID_RESPONSE');
  });
});
