import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_AI_GOVERNANCE_POLICY, DEFAULT_AI_CONFIGURATION } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse, errorResponse } from '../../test-utils';
import { AiGovernancePanel } from './AiGovernancePanel';
import { AiUsagePanel } from './AiUsagePanel';
const id = '10000000-0000-4000-8000-000000000001';
const usage = {
  summary: {
    period: '2026-10',
    resetsAt: '2026-11-01T00:00:00Z',
    chargedTokens: 30,
    reservedTokens: 0,
    unknownTokens: 1200,
    active: 0,
    unknown: 1,
    monthlyLimit: 10000,
    dailyLimit: 2000,
    dailyUsed: 1230,
    remainingTokens: 8770,
    mode: 'observe',
  },
  attempts: [
    {
      id,
      actorUserId: id,
      status: 'outcome_unknown',
      contentOutcome: null,
      reservedTokens: 1200,
      chargedTokens: 0,
      inputTokens: null,
      outputTokens: null,
      usageKind: 'pending',
      estimatedCost: null,
      currency: 'USD',
      createdAt: '2026-10-16 00:00:00',
      completedAt: null,
    },
  ],
};
afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});
function mount({ manage = true, personal = false, fail = false } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const q = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  q.setQueryData(authQueryKeys.session(), {
    userId: id,
    email: 'synthetic@example.test',
    displayName: 'Fixture',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const client = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: async (url, init) => {
      const path = String(url);
      if (init?.method === 'PUT') {
        calls.push({ url: path, init });
        return jsonResponse({
          data: {
            policy: JSON.parse(String(init.body)),
            revision: 1,
            canManage: manage,
            blockedReason: null,
          },
        });
      }
      if (path.endsWith('/usage') || path.endsWith('/ai-usage'))
        return fail ? errorResponse('INTERNAL', 'Synthetic', 500) : jsonResponse({ data: usage });
      if (path.endsWith('/admin/ai'))
        return jsonResponse({
          data: {
            configuration: DEFAULT_AI_CONFIGURATION,
            revision: 3,
            canManage: manage,
            workersAiAvailable: false,
            hasApiKey: false,
          },
        });
      if (path.includes('ai-governance'))
        return jsonResponse({
          data: {
            policy: DEFAULT_AI_GOVERNANCE_POLICY,
            revision: 0,
            canManage: manage,
            blockedReason: null,
          },
        });
      return jsonResponse({
        data: { user: { id, email: 'synthetic@example.test', displayName: 'Fixture' } },
      });
    },
  });
  render(
    <QueryClientProvider client={q}>
      <ApiClientProvider client={client}>
        {personal ? <AiUsagePanel /> : <AiGovernancePanel />}
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return calls;
}
describe('CAP-072 governance UI', () => {
  it('shows unknown holds separately, keeps unknown prices blank and hides management for readers', async () => {
    mount({ manage: false });
    expect(await screen.findAllByText('1200')).toHaveLength(2);
    expect(
      screen.getByText(
        'Observation mode records usage; token quotas are not enforced. Concurrency limits still apply.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit AI governance' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Record terminal evidence' }),
    ).not.toBeInTheDocument();
  });
  it('saves both scope limits with the original revision and keeps omitted prices unknown', async () => {
    const calls = mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit AI governance' }));
    const dialog = screen.getByRole('dialog');
    const field = within(dialog).getByLabelText('Installation monthly tokens');
    await user.clear(field);
    await user.type(field, '250000');
    await user.click(within(dialog).getByRole('button', { name: 'Save AI governance' }));
    await screen.findByRole('button', { name: 'Edit AI governance' });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]?.init.headers).get('If-Match')).toBe('0');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      monthlyTokens: 250000,
      userMonthlyTokens: 100000,
      inputPricePerMillion: null,
    });
  });
  it('personal usage has no admin or reconciliation controls and supports an unavailable state', async () => {
    mount({ personal: true, fail: true });
    expect(await screen.findByText('AI usage is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('AI usage governance')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh AI usage' })).toBeInTheDocument();
  });
});
