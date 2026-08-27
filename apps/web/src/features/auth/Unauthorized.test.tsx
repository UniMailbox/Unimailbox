// apps/web — Unauthorized tests.
//
// CAP-042 (Batch 5) AC 20. The shared 401 / expired-session view
// renders the same body, with the only difference being the title and
// a `data-testid` so a reviewer can verify which state was rendered.
//
// CAP-042 (Batch 8) L-3 fix: the CTA is a single `<Button>` whose
// `onClick` navigates to `/login`. The previous test asserted a
// `unauthorized-login-link` data-testid wrapping the button; the new
// pattern exposes the click handler so the test now exercises the
// navigation instead of the wrapping `<Link>`.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Unauthorized } from './Unauthorized';
import { renderAuthPage, spyFetch, lastPathname } from '../../test-utils';
import { resetAuthSessionForTesting } from './auth-session-store';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

describe('Unauthorized', () => {
  it('renders the unauthorized variant by default', async () => {
    const { fetchImpl } = spyFetch([]);
    await renderAuthPage({
      fetchImpl,
      mailbox: <Unauthorized />,
      initialPath: '/mailbox',
    });
    expect(screen.getByTestId('unauthorized-page')).toBeInTheDocument();
    expect(screen.getByText(/sign in to access the mailbox/i)).toBeInTheDocument();
  });

  it('renders the expired-session variant when requested', async () => {
    const { fetchImpl } = spyFetch([]);
    await renderAuthPage({
      fetchImpl,
      mailbox: <Unauthorized variant="expired" />,
      initialPath: '/mailbox',
    });
    expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    expect(screen.getByText(/your session ended/i)).toBeInTheDocument();
  });

  it('navigates to /login when the sign-in button is clicked (CAP-042 Batch 8 L-3)', async () => {
    const user = userEvent.setup();
    const { history } = await renderAuthPage({
      fetchImpl: spyFetch([]).fetchImpl,
      mailbox: <Unauthorized />,
      initialPath: '/mailbox',
    });
    expect(lastPathname(history)).toBe('/mailbox');
    await user.click(screen.getByTestId('unauthorized-login-button'));
    expect(lastPathname(history)).toBe('/login');
  });
});
