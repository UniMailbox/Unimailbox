import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminUserMailboxItem, UserListItem } from '@unimailbox/contracts';
import { createApiClient } from '../../infrastructure/api/client';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { setLanguage } from '../../infrastructure/i18n/locale';
import { UsersPage } from './UsersPage';
import { jsonResponse, errorResponse } from '../../test-utils';

const actorId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const session = {
  userId: actorId,
  email: 'admin@example.com',
  displayName: 'Admin',
  expiresAt: '',
  canAccessAdmin: true,
};
const user: UserListItem = {
  id: userId,
  email: 'person@example.com',
  displayName: 'Person',
  status: 'active',
  createdAt: '2026-10-12T00:00:00Z',
};
function box(n: number, role: AdminUserMailboxItem['role']): AdminUserMailboxItem {
  return {
    id: `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`,
    address: `box-${n}@example.com`,
    displayName: `Box ${n}`,
    status: 'active',
    domainId: '00000000-0000-4000-8000-000000000003',
    localPart: `box-${n}`,
    ownerUserId: role === 'owner' ? userId : actorId,
    role,
  };
}

function parent(element: HTMLElement): HTMLElement {
  if (element.parentElement === null) throw new Error('Expected mailbox row');
  return element.parentElement;
}

function mount(options: { failSave?: boolean; language?: 'zh-CN'; failList?: boolean } = {}) {
  setLanguage(options.language ?? 'en');
  const boxes = [box(1, 'owner'), box(2, 'viewer'), box(3, null)];
  const calls: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => 'synthetic-local-token',
    fetchImpl: (async (input, init) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ path, method, body, key: new Headers(init?.headers).get('Idempotency-Key') });
      if (path.endsWith('/auth/me'))
        return jsonResponse({
          data: {
            user: { id: actorId, email: session.email, displayName: 'Admin' },
            canAccessAdmin: true,
          },
        });
      if (path === '/api/v1/admin/users' && method === 'GET')
        return jsonResponse({ data: { items: [user], nextCursor: null } });
      if (path === '/api/v1/admin/mailboxes') return jsonResponse({ data: { items: boxes } });
      if (path === `/api/v1/admin/users/${userId}/mailboxes`) {
        if (options.failList) return errorResponse('PERMISSION_DENIED', 'Denied', 403);
        return jsonResponse({ data: { items: boxes } });
      }
      if (path.includes(`/admin/users/${userId}/mailboxes/`) && method === 'PUT') {
        if (options.failSave) return errorResponse('PERMISSION_DENIED', 'Save failed', 403);
        const mailbox = boxes.find((item) => path.endsWith(item.id));
        if (!mailbox) throw new Error('Fixture mailbox missing');
        const role = (body as { role: AdminUserMailboxItem['role'] }).role;
        boxes[boxes.indexOf(mailbox)] = { ...mailbox, role };
        return jsonResponse({ data: { userId, mailboxId: mailbox.id, role } });
      }
      if (path === '/api/v1/admin/users' && method === 'POST')
        return jsonResponse(
          {
            data: {
              user: { id: userId, email: 'new@example.com', displayName: 'New' },
              initialPassword: 'synthetic-initial-password',
              initialPasswordExpiresAt: '2099-01-01T00:00:00Z',
            },
          },
          201,
        );
      throw new Error(`Unhandled fixture path: ${method} ${path}`);
    }) as typeof fetch,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), session);
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <UsersPage />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

afterEach(() => {
  cleanup();
  setLanguage('en');
  resetAuthSessionForTesting();
});

describe('administrator user mailbox assignments', () => {
  it('R-MAILBOX-004 submits selected mailboxes with account creation and clears the selection', async () => {
    const { calls, queryClient } = mount();
    const interaction = userEvent.setup();
    expect(screen.queryByTestId('admin-create-user-form')).not.toBeInTheDocument();
    await interaction.click(await screen.findByRole('button', { name: 'Create account' }));
    await screen.findByTestId('admin-create-user-form');
    await interaction.type(screen.getByLabelText('Email'), 'new@example.com');
    await interaction.click(await screen.findByRole('checkbox', { name: 'box-2@example.com' }));
    await interaction.click(screen.getByRole('checkbox', { name: 'box-3@example.com' }));
    await interaction.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByTestId('admin-one-time-password')).toHaveTextContent(
      'synthetic-initial-password',
    );
    expect(calls.find((call) => call.method === 'POST')).toMatchObject({
      path: '/api/v1/admin/users',
      body: { email: 'new@example.com', mailboxIds: [box(2, null).id, box(3, null).id] },
      key: expect.any(String),
    });
    await interaction.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('admin-one-time-password')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state.data),
        ),
      ).not.toContain('synthetic-initial-password'),
    );
    await interaction.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('checkbox', { name: 'box-2@example.com' })).not.toBeChecked();
  });

  it('R-AUTHZ-003 updates and revokes one mailbox while protecting ownership and preserving other grants', async () => {
    const { calls } = mount();
    const interaction = userEvent.setup();
    await interaction.click(await screen.findByRole('button', { name: 'Mailbox access' }));
    const panel = within(await screen.findByTestId('admin-user-mailbox-access'));
    expect(await panel.findByText('Owner — full access')).toBeInTheDocument();
    expect(panel.queryByRole('combobox', { name: 'box-1@example.com' })).toBeNull();
    const viewer = await panel.findByRole('combobox', { name: 'box-2@example.com' });
    await interaction.selectOptions(viewer, 'sender');
    await interaction.click(within(parent(viewer)).getByRole('button', { name: 'Save' }));
    await panel.findByText('Mailbox access saved.');
    expect(calls.filter((call) => call.method === 'PUT')).toEqual([
      expect.objectContaining({
        path: `/api/v1/admin/users/${userId}/mailboxes/${box(2, null).id}`,
        body: { role: 'sender' },
        key: expect.any(String),
      }),
    ]);
    expect(panel.getByRole('combobox', { name: 'box-3@example.com' })).toHaveValue('none');
    const sender = panel.getByRole('combobox', { name: 'box-2@example.com' });
    await interaction.selectOptions(sender, 'none');
    await interaction.click(within(parent(sender)).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(panel.getByRole('combobox', { name: 'box-2@example.com' })).toHaveValue('none'),
    );
    expect(calls.filter((call) => call.method === 'PUT')[1]?.body).toEqual({ role: null });
  });

  it('R-API-002 retains unsaved selection after a failed update and does not show success', async () => {
    mount({ failSave: true });
    const interaction = userEvent.setup();
    await interaction.click(await screen.findByRole('button', { name: 'Mailbox access' }));
    const panel = within(await screen.findByTestId('admin-user-mailbox-access'));
    const select = await panel.findByRole('combobox', { name: 'box-2@example.com' });
    await interaction.selectOptions(select, 'admin');
    await interaction.click(within(parent(select)).getByRole('button', { name: 'Save' }));
    expect(await panel.findByRole('alert')).toHaveTextContent('PERMISSION_DENIED');
    expect(select).toHaveValue('admin');
    expect(panel.queryByText('Mailbox access saved.')).toBeNull();
    expect(within(parent(select)).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('R-AUTHZ-001 shows a denied access response without exposing grants', async () => {
    mount({ failList: true });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Mailbox access' }));
    const panel = within(await screen.findByTestId('admin-user-mailbox-access'));
    expect(await panel.findByRole('alert')).toHaveTextContent('PERMISSION_DENIED');
    expect(panel.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('opens grant editing as a modal and restores focus on Escape without writing', async () => {
    const { calls } = mount();
    const interaction = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Mailbox access' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await interaction.click(trigger);
    const dialog = within(screen.getByRole('dialog', { name: 'Mailbox access' }));
    await interaction.selectOptions(
      await dialog.findByRole('combobox', { name: 'box-2@example.com' }),
      'sender',
    );
    await interaction.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
    await interaction.click(trigger);
    expect(await screen.findByRole('combobox', { name: 'box-2@example.com' })).toHaveValue(
      'viewer',
    );
  });

  it('renders Chinese assignment controls and permission options', async () => {
    mount({ language: 'zh-CN' });
    const interaction = userEvent.setup();
    await interaction.click(await screen.findByRole('button', { name: '创建账户' }));
    expect(await screen.findByText('分配邮箱')).toBeInTheDocument();
    await interaction.keyboard('{Escape}');
    await userEvent.setup().click(await screen.findByRole('button', { name: '邮箱权限' }));
    const panel = within(await screen.findByTestId('admin-user-mailbox-access'));
    const select = await panel.findByRole('combobox', { name: 'box-2@example.com' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['无权限', '仅查看', '查看和发信', '全部邮箱操作权限']);
  });
});
