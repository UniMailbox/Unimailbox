import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type UpdateCheckResponse, UPSTREAM_URL, UPGRADE_GUIDE_URL } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { setLanguage } from '../../infrastructure/i18n/locale';
import { jsonResponse, errorResponse } from '../../test-utils';
import { UpdatePanel } from './UpdatePanel';
import { fetchUpdateCheck, updateQueryKey } from './update-queries';

const response: UpdateCheckResponse = {
  current: { version: '1.0.0', revision: '1234567890abcdef' },
  status: 'available',
  latest: { tag: 'v1.1.0', publishedAt: '2026-10-12T00:00:00Z' },
  checkedAt: '2026-10-12T00:00:00Z',
};
afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
  setLanguage('en');
});

function mount(result: UpdateCheckResponse | number = response) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(authQueryKeys.session(), {
    userId: 'updates-admin',
    email: 'admin@example.com',
    displayName: 'Admin',
    expiresAt: '2099-01-01T00:00:00Z',
  });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).includes('/auth/me'))
      return jsonResponse({
        data: { user: { id: 'updates-admin', email: 'admin@example.com', displayName: 'Admin' } },
      });
    return typeof result === 'number'
      ? errorResponse('PERMISSION_DENIED', 'Denied', result)
      : jsonResponse({ data: result });
  });
  const client = createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>
        <UpdatePanel />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { queryClient, fetchImpl };
}

describe('administrator software update notice', () => {
  it('offers release notes and upgrade instructions without an automatic deployment action', async () => {
    mount();
    expect(await screen.findByText('A new version is available: v1.1.0.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      `${UPSTREAM_URL}/releases/tag/v1.1.0`,
    );
    expect(screen.getByRole('link', { name: 'Upgrade guide' })).toHaveAttribute(
      'href',
      UPGRADE_GUIDE_URL,
    );
    expect(screen.getByText(/Installed base version: 1.0.0/)).toBeInTheDocument();
    expect(screen.getByText(/1234567890ab/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it.each([
    ['current', 'You are running the latest stable version.'],
    ['ahead', 'This installation is ahead of the latest stable release.'],
    ['no_release', 'No stable release has been published yet.'],
    ['unavailable', 'Could not check for updates. Try again later or view GitHub releases.'],
    ['disabled', 'Update checks are disabled for this installation.'],
  ] as const)('renders the %s state honestly', async (status, message) => {
    mount({ ...response, status, latest: null });
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
  it('renders Chinese copy and permits a retry after network failure', async () => {
    setLanguage('zh-CN');
    const { fetchImpl } = mount(500);
    expect(
      await screen.findByText('无法检查更新。请稍后重试或查看 GitHub 发布页面。'),
    ).toBeInTheDocument();
    const callsBefore = fetchImpl.mock.calls.length;
    await userEvent.setup().click(screen.getByRole('button', { name: '检查更新' }));
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsBefore);
  });
  it('hides previously cached data when permission has been revoked', async () => {
    const { queryClient } = mount(403);
    queryClient.setQueryData(updateQueryKey('updates-admin'), response);
    await waitFor(() => expect(screen.queryByTestId('admin-updates')).toBeNull());
  });
  it('uses user-scoped cache keys and rejects unsafe tags', async () => {
    expect(updateQueryKey('a')).not.toEqual(updateQueryKey('b'));
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: async () =>
        jsonResponse({ data: { ...response, latest: { ...response.latest, tag: '../evil' } } }),
    });
    await expect(fetchUpdateCheck(client)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
