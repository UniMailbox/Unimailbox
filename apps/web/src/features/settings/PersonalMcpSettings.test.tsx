import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { buildMcpPrompt, type PersonalMcpSettings as McpSettings } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { errorResponse, jsonResponse } from '../../test-utils';
import { PersonalMcpSettings } from './PersonalMcpSettings';
const box = '00000000-0000-4000-8000-000000000011';
const id = '00000000-0000-4000-8000-000000000012';
const secret = 'umcp_' + 'f'.repeat(64);
const initial: McpSettings = {
  enabled: true,
  endpoint: 'https://mail.example.test/api/mcp',
  promptTemplate: 'Shared administrator prompt: {{endpoint}}',
  tokens: [],
  nextCursor: null,
  mailboxes: [{ id: box, address: 'fixture@example.test', canWrite: true }],
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  resetAuthSessionForTesting();
  vi.restoreAllMocks();
});
function mount(data = initial) {
  let failReads = false;
  let nextPage = { tokens: [] as McpSettings['tokens'], nextCursor: null as string | null };
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const reads = { settings: 0, session: 0 };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
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
      if (path.includes('/auth/me/mcp/tokens?')) {
        calls.push({ path, init: init ?? {} });
        return jsonResponse({ data: nextPage });
      }
      if (path.endsWith('/auth/me')) {
        reads.session++;
        return jsonResponse({
          data: {
            user: { id: 'member-fixture', email: 'member@example.test', displayName: 'Member' },
            canAccessAdmin: false,
          },
        });
      }
      if (path.endsWith('/auth/me/mcp')) {
        reads.settings++;
        if (failReads) return errorResponse('INTERNAL', 'Fixture error', 503);
      }
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
  const settings = (visible = true) => (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        {visible ? <PersonalMcpSettings userId="member-fixture" /> : null}
      </ApiClientProvider>
    </QueryClientProvider>
  );
  const view = render(settings());
  return {
    calls,
    reads,
    queryClient,
    view,
    setVisible: (visible: boolean) => view.rerender(settings(visible)),
    setNextPage: (page: typeof nextPage) => {
      nextPage = page;
    },
    setRemote: (next: McpSettings) => {
      data = next;
    },
    failReads: () => {
      failReads = true;
    },
  };
}
describe('personal MCP access in Quick settings', () => {
  it('does not multiply a failed settings request through client or query retries', async () => {
    const { reads, failReads } = mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh MCP settings' })).toBeEnabled(),
    );
    failReads();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh MCP settings' }));
    await screen.findByRole('alert');
    expect(reads.settings).toBe(2);
    expect(reads.session).toBe(0);
  });
  it.each([true, false])(
    'refreshes on opening and request, without idle/focus/reconnect reads (enabled=%s)',
    async (enabled) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { reads, setVisible, setRemote } = mount({ ...initial, enabled });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Refresh MCP settings' })).toBeEnabled(),
      );
      expect(reads).toEqual({ settings: 1, session: 0 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_600_000);
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      expect(reads).toEqual({ settings: 1, session: 0 });
      setRemote({ ...initial, enabled: !enabled });
      fireEvent.click(screen.getByRole('button', { name: 'Refresh MCP settings' }));
      await waitFor(() => expect(reads.settings).toBe(2));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Refresh MCP settings' })).toBeEnabled(),
      );
      expect(!!screen.queryByRole('button', { name: 'Manage agent access' })).toBe(!enabled);
      act(() => setVisible(false));
      act(() => setVisible(true));
      await waitFor(() => expect(reads.settings).toBe(3));
      expect(reads.session).toBe(0);
    },
  );
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
  it('loads older credentials only on request and stops offering pagination at the last page', async () => {
    const user = userEvent.setup();
    const credential = {
      id,
      label: 'Recent agent',
      allowDraft: false,
      allowSend: false,
      mailboxIds: [box],
      expiresAt: 2000000000,
      revokedAt: null,
      createdAt: '2026-01-01',
    };
    const { calls, setNextPage } = mount({ ...initial, tokens: [credential], nextCursor: id });
    setNextPage({ tokens: [{ ...credential, id: box, label: 'Older agent' }], nextCursor: null });
    await user.click(await screen.findByRole('button', { name: 'Manage agent access' }));
    expect(calls).toHaveLength(0);
    expect(screen.queryByText('Older agent')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more credentials' }));
    expect(await screen.findByText('Older agent')).toBeInTheDocument();
    expect(calls.map((call) => call.path)).toEqual([`/api/v1/auth/me/mcp/tokens?cursor=${id}`]);
    expect(screen.queryByRole('button', { name: 'Load more credentials' })).not.toBeInTheDocument();
  });

  it('keeps credential revocation available while the service is disabled without exposing issuance or prompts', async () => {
    const user = userEvent.setup();
    const { calls } = mount({
      ...initial,
      enabled: false,
      tokens: [
        {
          id,
          label: 'Existing agent',
          allowDraft: false,
          allowSend: false,
          mailboxIds: [box],
          expiresAt: 2000000000,
          revokedAt: null,
          createdAt: '2026-01-01',
        },
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Manage agent access' }));
    expect(screen.queryByRole('button', { name: 'Create credential' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke credential: Existing agent' }));
    expect(await screen.findByText('Revoked')).toBeInTheDocument();
    expect(calls[0]?.path).toBe(`/api/v1/auth/me/mcp/tokens/${id}/revoke`);
  });

  it('does not expose personal configuration or Copy prompt when the administrator disables MCP', async () => {
    mount({ ...initial, enabled: false });
    await screen.findByText('MCP service is disabled. Contact an administrator to enable it.');
    expect(screen.queryByRole('button', { name: 'Manage agent access' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy prompt' })).not.toBeInTheDocument();
  });
});
