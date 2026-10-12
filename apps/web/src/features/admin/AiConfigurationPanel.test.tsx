import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_AI_CONFIGURATION, type AiConfigurationResponse } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse, errorResponse } from '../../test-utils';
import { AiConfigurationPanel } from './AiConfigurationPanel';

const initial: AiConfigurationResponse = {
  configuration: { ...DEFAULT_AI_CONFIGURATION, protocol: 'openai', model: 'test-model' },
  revision: 3,
  hasApiKey: true,
  canManage: true,
  workersAiAvailable: false,
};
afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});
function mount(data = initial, failWithConflict = false) {
  const calls: RequestInit[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), {
    userId: 'admin-ai',
    email: 'admin@example.com',
    displayName: 'Admin',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const client = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: async (input, init) => {
      if (String(input).includes('/auth/me'))
        return jsonResponse({
          data: { user: { id: 'admin-ai', email: 'admin@example.com', displayName: 'Admin' } },
        });
      if (init?.method === 'PUT') {
        calls.push(init);
        if (failWithConflict)
          return errorResponse('STALE_IF_MATCH', 'AI configuration changed', 412);
        const request = JSON.parse(String(init.body));
        return jsonResponse({
          data: {
            ...data,
            configuration: request.configuration,
            revision: data.revision + 1,
            hasApiKey: request.apiKey === null ? false : true,
          },
        });
      }
      return jsonResponse({ data });
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        <AiConfigurationPanel />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}
describe('AI configuration panel', () => {
  it('preserves an omitted key, sends revision and keeps secrets out of mutation variables', async () => {
    const { calls, queryClient } = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit AI configuration' }));
    const model = await screen.findByLabelText('Model ID');
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    await user.clear(model);
    await user.type(model, 'another-model');
    await user.click(screen.getByRole('button', { name: 'Save AI configuration' }));
    await screen.findByText('AI configuration saved.');
    const sent = calls[0];
    expect(new Headers(sent?.headers).get('If-Match')).toBe('3');
    expect(JSON.parse(String(sent?.body))).not.toHaveProperty('apiKey');
    expect(queryClient.getMutationCache().getAll()[0]?.state.variables).toBeUndefined();
  });
  it('clears replacement key after saving', async () => {
    const { calls, queryClient } = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit AI configuration' }));
    const key = await screen.findByLabelText('API Key');
    await user.type(key, 'private-ai-key');
    await user.click(screen.getByRole('button', { name: 'Save AI configuration' }));
    await screen.findByText('AI configuration saved.');
    expect(JSON.parse(String(calls[0]?.body)).apiKey).toBe('private-ai-key');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit AI configuration' }));
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('private-ai-key');
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      ),
    ).not.toContain('private-ai-key');
  });
  it('removes saved keys explicitly and disables inference', async () => {
    const { calls } = mount({
      ...initial,
      configuration: { ...initial.configuration, enabled: true },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit AI configuration' }));
    await user.click(screen.getByRole('button', { name: 'Remove saved API key' }));
    await user.click(screen.getByRole('button', { name: 'Save AI configuration' }));
    await screen.findByText('AI configuration saved.');
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      apiKey: null,
      configuration: { enabled: false },
    });
  });
  it('clears typed key when switching endpoint and protocol', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit AI configuration' }));
    const key = await screen.findByLabelText('API Key');
    await user.type(key, 'old-key');
    await user.type(screen.getByLabelText('Service base URL'), 'https://other.example.com');
    expect(key).toHaveValue('');
    await user.type(key, 'next-key');
    await user.click(screen.getByRole('combobox', { name: 'API protocol' }));
    await user.click(screen.getByRole('option', { name: 'Cloudflare Workers AI' }));
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(
      screen.getByText('Workers AI binding unavailable. Add the AI binding before enabling.'),
    ).toBeInTheDocument();
  });
  it('disables editing for read-only access and on a stale save', async () => {
    const { calls } = mount(initial, true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit AI configuration' }));
    await user.click(screen.getByRole('button', { name: 'Save AI configuration' }));
    await waitFor(() => expect(screen.getByLabelText('Model ID')).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Reload AI configuration' })).toBeEnabled();
    expect(calls).toHaveLength(1);
    cleanup();
    mount({ ...initial, canManage: false });
    expect(
      await screen.findByText('Read-only access. Ask an administrator to make changes.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit AI configuration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save AI configuration' })).not.toBeInTheDocument();
  });
  it('discards a cancelled edit and clears its typed key without saving', async () => {
    const { calls } = mount();
    const interaction = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Edit AI configuration' });
    expect(screen.queryByTestId('ai-configuration-form')).not.toBeInTheDocument();
    await interaction.click(trigger);
    await interaction.type(screen.getByLabelText('API Key'), 'cancelled-synthetic-key');
    await interaction.clear(screen.getByLabelText('Model ID'));
    await interaction.type(screen.getByLabelText('Model ID'), 'cancelled-model');
    await interaction.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(calls).toHaveLength(0);
    await interaction.click(trigger);
    expect(screen.getByLabelText('API Key')).toHaveValue('');
    expect(screen.getByLabelText('Model ID')).toHaveValue('test-model');
  });
});
