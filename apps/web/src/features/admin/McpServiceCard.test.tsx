import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DEFAULT_MCP_CONFIGURATION,
  buildMcpPrompt,
  type McpAdministration,
} from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse } from '../../test-utils';
import { McpServiceCard } from './McpServiceCard';

const initial: McpAdministration = {
  configuration: { ...DEFAULT_MCP_CONFIGURATION, enabled: true },
  revision: 3,
  endpoint: 'https://mail.example.test/api/mcp',
  canManage: true,
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
      if (String(input).endsWith('/auth/me'))
        return jsonResponse({
          data: { user: { id: 'fixture', email: 'admin@example.test', displayName: 'Admin' } },
        });
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
        <McpServiceCard userId="fixture" />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls };
}
describe('MCP card within AI services', () => {
  it('only toggles the service and hides credential/global send/rate forms', async () => {
    const user = userEvent.setup();
    const { calls } = mount();
    await user.click(await screen.findByRole('switch', { name: 'Enable MCP service' }));
    await screen.findByText('MCP configuration saved.');
    expect(new Headers(calls[0]?.headers).get('If-Match')).toBe('3');
    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      ...initial.configuration,
      enabled: false,
    });
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeDisabled();
    expect(screen.queryByLabelText('Grant send access')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Requests per minute per credential')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create credential' })).not.toBeInTheDocument();
  });
  it('views, previews, persists and copies the shared prompt with protected instructions', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { calls } = mount();
    await user.click(await screen.findByRole('button', { name: 'View / edit setup prompt' }));
    await user.clear(screen.getByLabelText('Prompt template'));
    await user.paste('Custom agent instructions: {{endpoint}}');
    await user.click(screen.getByText('Preview copied prompt'));
    expect(screen.getByText(/Custom agent instructions: https:/)).toHaveTextContent(
      'explicit human approval',
    );
    await user.click(screen.getByRole('button', { name: 'Save prompt' }));
    await screen.findByText('MCP configuration saved.');
    expect(JSON.parse(String(calls[0]?.body)).promptTemplate).toBe(
      'Custom agent instructions: {{endpoint}}',
    );
    await user.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(clipboard).toHaveBeenLastCalledWith(
      buildMcpPrompt(initial.endpoint, 'Custom agent instructions: {{endpoint}}'),
    );
  });
  it('lets read-only admins view the prompt even while disabled', async () => {
    const user = userEvent.setup();
    mount({
      ...initial,
      canManage: false,
      configuration: { ...initial.configuration, enabled: false },
    });
    expect(await screen.findByRole('switch', { name: 'Enable MCP service' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'View setup prompt' }));
    expect(screen.getByLabelText('Prompt template')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save prompt' })).not.toBeInTheDocument();
  });
});
