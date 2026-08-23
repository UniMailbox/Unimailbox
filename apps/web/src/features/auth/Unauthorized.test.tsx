// apps/web — Unauthorized tests.
//
// CAP-042 (Batch 5) AC 20. The shared 401 / expired-session view
// renders the same body, with the only difference being the title and
// a `data-testid` so a reviewer can verify which state was rendered.
//
// The component uses TanStack Router's `<Link>` so the test mounts it
// inside a real router via `renderAuthPage`.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { Unauthorized } from './Unauthorized';
import { renderAuthPage, spyFetch } from '../../test-utils';
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

  it('exposes a link to /login', async () => {
    const { fetchImpl } = spyFetch([]);
    await renderAuthPage({
      fetchImpl,
      mailbox: <Unauthorized />,
      initialPath: '/mailbox',
    });
    expect(screen.getByTestId('unauthorized-login-link')).toBeInTheDocument();
  });
});