// apps/web — MailboxShell tests.
//
// CAP-042 (Batch 5) AC 20 — basic shell render after a successful
// sign-in. The full inbox/thread/compose shell lands with CAP-043/044.
//
// CAP-042 (Batch 8) L-4 fix: when the auth-session cache resolves to
// `null` (session expired mid-render, cookie cleared between the
// router's `beforeLoad` and the component mount), the shell must
// render `<Unauthorized variant="expired" />` rather than an indefinite
// `<MailboxLoading />` spinner.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { MailboxShell } from './MailboxShell';
import { authQueryKeys } from '../auth/auth-queries';
import { spyFetch } from '../../test-utils';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

function renderShellWithSession(session: unknown): void {
  const { fetchImpl } = spyFetch([]);
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(authQueryKeys.session(), session);
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <MailboxShell />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe('MailboxShell', () => {
  it('renders the shell when a valid descriptor is in the cache', () => {
    renderShellWithSession({
      userId: 'u-shell',
      email: 'shell@b.test',
      displayName: 'Shell',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    expect(screen.getByTestId('mailbox-shell')).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-user-email').textContent).toBe('shell@b.test');
  });

  // CAP-042 Batch 8 (L-4 fix): the deeper fallback when the session
  // resolved to null (expired mid-render). Without this branch, the
  // user sees an infinite spinner.
  it('renders <Unauthorized variant="expired" /> when the cache holds null', () => {
    renderShellWithSession(null);
    expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    expect(screen.queryByTestId('mailbox-loading')).toBeNull();
    expect(screen.queryByTestId('mailbox-shell')).toBeNull();
  });
});
