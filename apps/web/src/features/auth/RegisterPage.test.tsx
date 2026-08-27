// apps/web — RegisterPage tests.
//
// CAP-042 (Batch 5) AC 20. The register form posts to
// /api/v1/auth/register (the legacy application endpoint — Better Auth's
// `sign-up/email` is disabled at the framework level). On success the
// page navigates to /login (registration is separate from sign-in
// per R-AUTH-006 / CAP-019).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RegisterPage } from './RegisterPage';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  renderAuthPage,
  spyFetch,
} from '../../test-utils';
import { resetAuthSessionForTesting } from './auth-session-store';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetAuthSessionForTesting();
});

const VALID_CODE = 'a'.repeat(64);

describe('RegisterPage', () => {
  it('submits the registration payload and navigates to /login on success', async () => {
    const { fetchImpl, calls } = spyFetch([
      () =>
        jsonResponse({
          data: {
            user: { id: 'u-new', email: 'new@b.test', displayName: 'New' },
          },
        }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderAuthPage({
      fetchImpl,
      initialPath: '/register',
      register: <RegisterPage />,
    });
    await user.type(screen.getByLabelText(/invite code/i), VALID_CODE);
    await user.type(screen.getByLabelText(/^email/i), 'new@b.test');
    await user.type(screen.getByLabelText(/^password/i), 'secret123');
    await user.type(screen.getByLabelText(/display name/i), 'New');
    await user.click(screen.getByTestId('register-submit'));
    await waitFor(() => {
      expect(lastPathname(history)).toBe('/login');
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('/api/v1/auth/register');
    expect(calls[0]?.method).toBe('POST');
  });

  it('surfaces the machine code on 4xx (R-API-002)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('REGISTRATION_CODE_INVALID', 'Invalid code', 409),
    ]);
    const user = userEvent.setup();
    await renderAuthPage({
      fetchImpl,
      initialPath: '/register',
      register: <RegisterPage />,
    });
    await user.type(screen.getByLabelText(/invite code/i), VALID_CODE);
    await user.type(screen.getByLabelText(/^email/i), 'new@b.test');
    await user.type(screen.getByLabelText(/^password/i), 'secret123');
    await user.click(screen.getByTestId('register-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('REGISTRATION_CODE_INVALID');
  });

  it('does not call fetch when the invite code is the wrong length (zod rejects)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderAuthPage({
      fetchImpl,
      initialPath: '/register',
      register: <RegisterPage />,
    });
    await user.type(screen.getByLabelText(/invite code/i), 'short');
    await user.type(screen.getByLabelText(/^email/i), 'new@b.test');
    await user.type(screen.getByLabelText(/^password/i), 'secret123');
    await user.click(screen.getByTestId('register-submit'));
    expect(calls.length).toBe(0);
  });
});
