import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
import { permissionKeySchema } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { RolesPage } from './RolesPage';
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

const PERMISSIONS = permissionKeySchema.options.map((key) => ({
  key,
  description:
    key === 'message.read'
      ? 'Read messages'
      : key === 'message.send'
        ? 'Send messages'
        : key === 'role.manage'
          ? 'Manage roles'
          : `Permission ${key}`,
}));

const SYSTEM_ROLES = [
  {
    id: 'administrator',
    name: 'administrator',
    description: 'Full system access',
    isSystem: true,
    permissionKeys: ['message.read', 'role.manage'],
  },
  {
    id: 'member',
    name: 'member',
    description: 'Standard user',
    isSystem: true,
    permissionKeys: ['message.read'],
  },
];

function customRole() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Support agent',
    description: 'Read and send mail',
    isSystem: false,
    permissionKeys: ['message.read'],
  };
}

function mountRolesPage(
  resolvers: Array<(call: { url: string; method: string; body?: string }) => Response>,
): { calls: Array<{ url: string; method: string; body?: string }> } {
  const { fetchImpl: sequentialFetch } = spyFetch(resolvers);
  const calls: Array<{ url: string; method: string; body?: string }> = [];
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
    calls.push({
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
  const rolesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/roles',
    component: RolesPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([rolesRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin/roles'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

function listResponse(roles = [customRole()]) {
  return jsonResponse({ data: { roles: [...SYSTEM_ROLES, ...roles], permissions: PERMISSIONS } });
}

describe('RolesPage (CAP-067)', () => {
  it('renders system roles read-only and creates a custom role with selected permissions', async () => {
    const created = {
      ...customRole(),
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Sender',
      description: 'Can send',
      permissionKeys: ['message.send'],
    };
    const { calls } = mountRolesPage([
      () => listResponse([]),
      (call) => {
        expect(call.method).toBe('POST');
        return jsonResponse({ data: created }, 201);
      },
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-roles-page')).toBeInTheDocument());
    const systemRole = screen.getByTestId('role-administrator-read-only');
    expect(systemRole).toBeInTheDocument();
    expect(within(systemRole).queryByRole('button')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Role name'), 'Sender');
    await user.type(screen.getByLabelText('Role description'), 'Can send');
    await user.click(screen.getByLabelText('Send messages'));
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() =>
      expect(screen.getByTestId('role-success')).toHaveTextContent('Created Sender.'),
    );
    const post = calls.find((call) => call.method === 'POST');
    expect(JSON.parse(post?.body ?? '')).toEqual({
      name: 'Sender',
      description: 'Can send',
      permissionKeys: ['message.send'],
    });
  });

  it('replaces custom permissions on update and requires confirmation before delete', async () => {
    const role = customRole();
    const updated = { ...role, name: 'Support v2', permissionKeys: ['message.send'] };
    const { calls } = mountRolesPage([
      () => listResponse(),
      (call) => {
        expect(call.method).toBe('PATCH');
        return jsonResponse({ data: updated });
      },
      (call) => {
        expect(call.method).toBe('DELETE');
        return jsonResponse({ data: { id: role.id, deleted: true } });
      },
    ]);
    await waitFor(() => expect(screen.getByTestId(`role-form-${role.id}`)).toBeInTheDocument());
    const user = userEvent.setup();
    const form = screen.getByTestId(`role-form-${role.id}`);
    const name = screen.getByLabelText('Edit Support agent role name');
    await user.clear(name);
    await user.type(name, 'Support v2');
    await user.click(screen.getByLabelText('Edit Support agent: Send messages'));
    await user.click(screen.getByRole('button', { name: 'Save Support agent' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete Support v2' })).toBeInTheDocument(),
    );
    expect(form).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete Support v2' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('alert-dialog-cancel'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete Support v2' }));
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    await waitFor(() =>
      expect(screen.queryByTestId(`role-form-${role.id}`)).not.toBeInTheDocument(),
    );
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
  });

  it('shows edit validation failures without sending a mutation', async () => {
    const role = customRole();
    const { calls } = mountRolesPage([() => listResponse()]);
    await waitFor(() => expect(screen.getByTestId(`role-form-${role.id}`)).toBeInTheDocument());
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Edit Support agent role name'));
    await user.click(screen.getByRole('button', { name: 'Save Support agent' }));
    expect(screen.getByTestId(`role-update-error-${role.id}`)).toHaveTextContent(
      'VALIDATION_ERROR',
    );
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('renders empty state and retries a non-authorization load failure', async () => {
    mountRolesPage([
      () => errorResponse('VALIDATION_ERROR', 'Try again', 400),
      () => jsonResponse({ data: { roles: [], permissions: PERMISSIONS } }),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-error')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('admin-roles-empty')).toBeInTheDocument());
  });

  it('renders a create mutation failure without a success notice', async () => {
    const { calls } = mountRolesPage([
      () => listResponse([]),
      () => errorResponse('ROLE_NAME_TAKEN', 'A role with this name already exists', 409),
    ]);
    await waitFor(() => expect(screen.getByTestId('admin-roles-page')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Role name'), 'Sender');
    await user.type(screen.getByLabelText('Role description'), 'Can send');
    await user.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() =>
      expect(screen.getByTestId('role-create-error')).toHaveTextContent('ROLE_NAME_TAKEN'),
    );
    expect(screen.queryByTestId('role-success')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('renders a server permission denial and invalid response as stable states', async () => {
    mountRolesPage([() => errorResponse('PERMISSION_DENIED', 'Permission denied', 403)]);
    await waitFor(() => expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument());

    cleanup();
    resetAuthSessionForTesting();
    mountRolesPage([() => jsonResponse({ data: { roles: [{ ...customRole(), secret: 'x' }] } })]);
    await waitFor(() => expect(screen.getByTestId('admin-error')).toBeInTheDocument());
    expect(screen.getByTestId('admin-error-panel')).toHaveTextContent('INVALID_RESPONSE');
  });
});
