// Public registration is closed. Accounts are created and managed by admins.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegisterPage } from './RegisterPage';
import { lastPathname, renderAuthPage, spyFetch } from '../../test-utils';
import { resetAuthSessionForTesting } from './auth-session-store';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetAuthSessionForTesting();
});

describe('RegisterPage', () => {
  it('explains that only administrators create accounts and makes no request', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await renderAuthPage({
      fetchImpl,
      initialPath: '/register',
      register: <RegisterPage />,
    });

    expect(screen.getByTestId('registration-disabled')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await userEvent.setup().click(screen.getByTestId('registration-login-link'));
    await waitFor(() => expect(lastPathname(history)).toBe('/login'));
  });
});
