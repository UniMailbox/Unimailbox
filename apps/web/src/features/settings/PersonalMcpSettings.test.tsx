import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { buildMcpPrompt, type PersonalMcpSettings as McpSettings } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse } from '../../test-utils';
import { PersonalMcpSettings } from './PersonalMcpSettings';
const box = '00000000-0000-4000-8000-000000000011';
const id = '00000000-0000-4000-8000-000000000012';
const secret = 'umcp_' + 'f'.repeat(64);
const initial: McpSettings = {
  enabled: true,
  endpoint: 'https://mail.example.test/api/mcp',
  promptTemplate: 'Shared administrator prompt: {{endpoint}}',
  tokens: [],
  mailboxes: [{ id: box, address: 'fixture@example.test', canWrite: true }],
};
afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
  vi.restoreAllMocks();
});
function mount(data = initial) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(authQueryKeys.session(), {
    userId: 'member-fixture',
    email: 'member@example.test',
    displayName: 'Member',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const client = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: async (input, init) => {
      const path = String(input);
      if (path.endsWith('/auth/me'))
        return jsonResponse({
          data: {
            user: { id: 'member-fixture', email: 'member@example.test', displayName: 'Member' },
            canAccessAdmin: false,
          },
        });
      if (init?.method === 'POST') {
        calls.push({ path, init });
        if (path.endsWith('/revoke')) {
          data = { ...data, tokens: data.tokens.map((token) => ({ ...token, revokedAt: 1 })) };
          return jsonResponse({ data: { revoked: true } });
        }
        const request = JSON.parse(String(init.body));
        const credential = {
          id,
          label: request.label,
          allowDraft: request.allowDraft,
          allowSend: request.allowSend,
          mailboxIds: request.mailboxIds,
          expiresAt: 2000000000,
          revokedAt: null,
          createdAt: '2026-01-01',
        };
        data = { ...data, tokens: [credential] };
        return jsonResponse({ data: { credential, token: secret } });
      }
      return jsonResponse({ data });
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        <PersonalMcpSettings />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, queryClient, view };
}
describe('personal MCP access in Quick settings', () => {
  it('allows members to select independent send access and keeps one-time credentials out of caches/prompts', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { calls, queryClient } = mount();
    await user.click(await screen.findByRole('button', { name: 'Manage agent access' }));
    await user.click(screen.getByRole('checkbox', { name: /fixture@example.test/ }));
    await user.click(screen.getByRole('checkbox', { name: /Grant send access/ }));
    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    expect(await screen.findByLabelText('One-time credential')).toHaveValue(secret);
    expect(calls[0]?.path).toBe('/api/v1/auth/me/mcp/tokens');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      mailboxIds: [box],
      allowDraft: false,
      allowSend: true,
    });
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(secret);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Copy prompt' }),
    );
    expect(clipboard).toHaveBeenLastCalledWith(
      buildMcpPrompt(initial.endpoint, initial.promptTemplate),
    );
    expect(clipboard.mock.calls.at(-1)?.[0]).not.toContain(secret);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('One-time credential')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Revoke credential:/ }));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(calls[1]?.path).toBe(`/api/v1/auth/me/mcp/tokens/${id}/revoke`);
  });
  it('offers only read grants for viewer mailboxes and clears a credential when its dialog closes', async () => {
    const user = userEvent.setup();
    mount({
      ...initial,
      mailboxes: [{ id: box, address: 'fixture@example.test', canWrite: false }],
    });
    await user.click(await screen.findByRole('button', { name: 'Manage agent access' }));
    await user.click(screen.getByRole('checkbox', { name: /fixture@example.test/ }));
    expect(screen.getByRole('checkbox', { name: /Grant send access/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Allow drafts/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    await screen.findByLabelText('One-time credential');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Manage agent access' }));
    expect(screen.queryByLabelText('One-time credential')).not.toBeInTheDocument();
  });
  it('does not expose personal configuration or Copy prompt when the administrator disables MCP', async () => {
    mount({ ...initial, enabled: false });
    await screen.findByText('MCP service is disabled. Contact an administrator to enable it.');
    expect(screen.queryByRole('button', { name: 'Manage agent access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).not.toBeInTheDocument();
  });
});
