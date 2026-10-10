// apps/web — LoginPage tests.
//
// CAP-042 (Batch 5) AC 20 + AC 22. The login form posts to
// /api/v1/auth/login and:
// - on success stores the descriptor in the in-memory store and
//   navigates to /mailbox;
// - on 401 surfaces an "unauthorized" ErrorPanel;
// - on other 4xx surfaces the machine code via ErrorPanel;
// - does not call fetch when the form is empty (zod rejects).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './LoginPage';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  renderAuthPage,
  spyFetch,
} from '../../test-utils';
import { resetAuthSessionForTesting, useAuthSession } from './auth-session-store';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetAuthSessionForTesting();
});

describe('LoginPage', () => {
  it('submits the credentials, stores the descriptor, and navigates to /mailbox', async () => {
    const { fetchImpl, calls } = spyFetch([
      () =>
        jsonResponse({
          data: {
            accessToken: 'access-token-test',
            user: { id: 'u-1', email: 'a@b.test', displayName: 'A B' },
            mustChangePassword: false,
          },
        }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderAuthPage({
      fetchImpl,
      login: <LoginPage />,
    });
    await user.type(screen.getByLabelText(/email/i), 'a@b.test');
    await user.type(screen.getByLabelText(/^password$/i), 'secret123');
    await user.click(screen.getByTestId('login-submit'));
    await waitFor(() => {
      expect(lastPathname(history)).toBe('/mailbox');
    });
    const signInCall = calls.find((c) => c.url === '/api/v1/auth/login');
    expect(signInCall?.method).toBe('POST');
    // The in-memory descriptor is populated after sign-in resolves.
    const state = useAuthSession.getState();
    expect(state.session?.userId).toBe('u-1');
    expect(state.session?.email).toBe('a@b.test');
  });

  it('surfaces a 401 with the unauthorized ErrorPanel', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password', 401),
    ]);
    const user = userEvent.setup();
    await renderAuthPage({ fetchImpl, login: <LoginPage /> });
    await user.type(screen.getByLabelText(/email/i), 'wrong@b.test');
    // CAP-042 Batch 8 (L-2 fix): the schema rejects passwords shorter
    // than 6 chars client-side, so this test now uses a 7-char
    // password that zod accepts. The 5-char bound is covered by the
    // dedicated validation-error test below.
    await user.type(screen.getByLabelText(/^password$/i), 'wrongpw');
    await user.click(screen.getByTestId('login-submit'));
    const code = await screen.findByTestId('login-unauthorized');
    expect(code).toBeInTheDocument();
    expect(screen.getByTestId('error-code').textContent).toBe('INVALID_EMAIL_OR_PASSWORD');
  });

  it('surfaces the machine code on 4xx (R-API-002)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('VALIDATION_ERROR', 'Email required', 400),
    ]);
    const user = userEvent.setup();
    await renderAuthPage({ fetchImpl, login: <LoginPage /> });
    // Form must pass zod so the request actually goes out and the
    // server's 4xx surfaces via ErrorPanel.
    await user.type(screen.getByLabelText(/email/i), 'user@b.test');
    await user.type(screen.getByLabelText(/^password$/i), 'secret123');
    await user.click(screen.getByTestId('login-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('VALIDATION_ERROR');
  });

  it('does not call fetch when the email field is empty (zod rejects)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderAuthPage({ fetchImpl, login: <LoginPage /> });
    await user.click(screen.getByTestId('login-submit'));
    // The fetch implementation should not have been invoked because
    // the zod resolver rejects empty input.
    expect(calls.length).toBe(0);
    expect(useAuthSession.getState().session).toBeNull();
  });

  // CAP-042 Batch 8 (L-2 fix): the client-side schema now mirrors
  // R-AUTH-007 (6..30 characters). Below-min and above-max passwords
  // are rejected by zod before the request goes out — the server-side
  // rule is the authoritative one, but the client surfaces the same
  // bound so a user gets an immediate validation error.
  it('rejects a 5-character password with a min-length validation error (R-AUTH-007)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderAuthPage({ fetchImpl, login: <LoginPage /> });
    await user.type(screen.getByLabelText(/email/i), 'short@b.test');
    await user.type(screen.getByLabelText(/^password$/i), '12345');
    await user.click(screen.getByTestId('login-submit'));
    // zod rejects; no fetch, no submit error panel.
    expect(calls.length).toBe(0);
    expect(screen.queryByTestId('login-error')).toBeNull();
    expect(screen.queryByTestId('login-unauthorized')).toBeNull();
    expect(screen.getByLabelText(/^password$/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('rejects a 31-character password with a max-length validation error (R-AUTH-007)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderAuthPage({ fetchImpl, login: <LoginPage /> });
    await user.type(screen.getByLabelText(/email/i), 'long@b.test');
    await user.type(screen.getByLabelText(/^password$/i), 'a'.repeat(31));
    await user.click(screen.getByTestId('login-submit'));
    expect(calls.length).toBe(0);
    expect(screen.queryByTestId('login-error')).toBeNull();
    expect(screen.queryByTestId('login-unauthorized')).toBeNull();
    expect(screen.getByLabelText(/^password$/i).getAttribute('aria-invalid')).toBe('true');
  });
});
