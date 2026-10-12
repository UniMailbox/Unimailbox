import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type McpAdministration } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse } from '../../test-utils';
import { McpConfigurationPanel } from './McpSettingsPage';
import { buildMcpPrompt } from './mcp-prompt';

const box = '00000000-0000-4000-8000-000000000011';
const credentialId = '00000000-0000-4000-8000-000000000012';
const secret = 'umcp_' + 'f'.repeat(64);
const initial: McpAdministration = {
  configuration: { enabled: true, allowSend: false, requestsPerMinute: 30 },
  revision: 3,
  endpoint: 'https://mail.example.test/api/mcp',
  canManage: true,
  tokens: [],
  mailboxes: [{ id: box, address: 'fixture@example.test' }],
};
afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
  vi.restoreAllMocks();
});
function mount(data = initial) {
  const calls: RequestInit[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(authQueryKeys.session(), {
    userId: 'fixture',
    email: 'admin@example.test',
    displayName: 'Admin',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const client = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: async (input, init) => {
      if (String(input).includes('/auth/me'))
        return jsonResponse({
          data: { user: { id: 'fixture', email: 'admin@example.test', displayName: 'Admin' } },
        });
      if (init?.method === 'POST') {
        calls.push(init);
        return jsonResponse({
          data: {
            credential: {
              id: credentialId,
              label: 'Local AI agent',
              allowDraft: true,
              allowSend: false,
              mailboxIds: [box],
              expiresAt: 2000000000,
              revokedAt: null,
              createdAt: '2026-01-01',
            },
            token: secret,
          },
        });
      }
      if (init?.method === 'PUT') {
        calls.push(init);
        data = {
          ...data,
          configuration: JSON.parse(String(init.body)),
          revision: data.revision + 1,
        };
      }
      return jsonResponse({ data });
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        <McpConfigurationPanel />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}
describe('MCP settings', () => {
  it('copies a usable prompt without any secret, and discards a one-time credential', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { calls, queryClient } = mount();
    await user.click(await screen.findByLabelText('fixture@example.test'));
    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    expect(await screen.findByLabelText('One-time credential')).toHaveValue(secret);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      mailboxIds: [box],
      allowDraft: true,
      allowSend: false,
    });
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(clipboard).toHaveBeenLastCalledWith(buildMcpPrompt(initial.endpoint));
    expect(clipboard.mock.calls.at(-1)?.[0]).not.toContain(secret);
    expect(clipboard.mock.calls.at(-1)?.[0]).toContain('UNIMAILBOX_MCP_TOKEN');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByLabelText('One-time credential')).not.toBeInTheDocument();
  });
  it('saves revision-checked configuration and disables prompt and credentials when off', async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    await user.click(await screen.findByRole('switch', { name: 'Enable MCP service' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('MCP configuration saved.');
    expect(new Headers(calls[0]?.headers).get('If-Match')).toBe('3');
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create credential' })).toBeDisabled();
  });
  it('provides read-only administration without mutation controls', async () => {
    mount({ ...initial, canManage: false });
    expect(await screen.findByRole('switch', { name: 'Enable MCP service' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create credential' })).not.toBeInTheDocument();
  });
});
