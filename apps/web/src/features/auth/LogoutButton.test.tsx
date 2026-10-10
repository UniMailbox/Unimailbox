// apps/web — LogoutButton tests.
//
// CAP-042 (Batch 5) AC 20. The logout button posts to
// /api/v1/auth/logout, clears the in-memory session descriptor,
// removes the cache entry, and navigates to /login.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogoutButton } from './LogoutButton';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  renderAuthPage,
  spyFetch,
} from '../../test-utils';
import {
  resetAuthSessionForTesting,
  setAuthSession,
  useAuthSession,
  type AuthSessionDescriptor,
} from './auth-session-store';
import { authQueryKeys } from './auth-queries';

const SESSION: AuthSessionDescriptor = {
  userId: 'u-1',
  email: 'signed-in@b.test',
  displayName: 'Signed In',
  expiresAt: '2099-01-01T00:00:00Z',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetAuthSessionForTesting();
});

describe('LogoutButton', () => {
  it('posts to sign-out, clears the store, and navigates to /login', async () => {
    const { fetchImpl, calls } = spyFetch([() => jsonResponse({ success: true })]);
    setAuthSession(SESSION);
    const user = userEvent.setup();
    const { history, queryClient } = await renderAuthPage({
      fetchImpl,
      authSession: SESSION,
      // Mount the LogoutButton on the mailbox route so the test
      // exercises the same context the production mailbox shell uses.
      mailbox: <LogoutButton />,
      initialPath: '/mailbox',
    });
    // Pre-condition: the store is populated.
    expect(useAuthSession.getState().session?.userId).toBe('u-1');
    await user.click(screen.getByTestId('logout-button'));
    await waitFor(() => {
      expect(lastPathname(history)).toBe('/login');
    });
    const signOutCall = calls.find((c) => c.url === '/api/v1/auth/logout');
    expect(signOutCall?.method).toBe('POST');
    expect(useAuthSession.getState().session).toBeNull();
    // The cache entry was removed so a subsequent /mailbox navigation
    // would re-fetch and find no session.
    expect(queryClient.getQueryData(authQueryKeys.session())).toBeUndefined();
  });

  it('still clears the store and redirects when sign-out fails', async () => {
    // 401 is non-retryable (per the AC #15 policy in
    // `infrastructure/api/retry.ts`) so the test does not need fake
    // timers. The contract under test is "a sign-out failure must
    // still clear the in-memory descriptor and navigate to /login";
    // the HTTP status that triggers the failure does not change the
    // outcome.
    const { fetchImpl } = spyFetch([
      () => errorResponse('UNAUTHORIZED', 'Session already ended', 401),
    ]);
    setAuthSession(SESSION);
    const user = userEvent.setup();
    const { history } = await renderAuthPage({
      fetchImpl,
      authSession: SESSION,
      mailbox: <LogoutButton />,
      initialPath: '/mailbox',
    });
    await user.click(screen.getByTestId('logout-button'));
    await waitFor(() => {
      expect(lastPathname(history)).toBe('/login');
    });
    expect(useAuthSession.getState().session).toBeNull();
  });
});
