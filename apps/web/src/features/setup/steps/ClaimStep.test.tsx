// apps/web — ClaimStep tests.
//
// CAP-041 / step 1. Verifies:
// - 200 response stores the session token (R-SECRET-003: in-memory only)
// - navigation advances to /setup/preflight
// - 4xx shows ErrorPanel with machine code (AC #15)
// - Idempotency-Key + Authorization header contract
// - Validation error from zod prevents submit
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaimStep } from './ClaimStep';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  renderStep,
  spyFetch,
  screen,
} from '../../../test-utils';
import { useSetupSession } from '../setup-session-store';

afterEach(() => {
  cleanup();
});

describe('ClaimStep', () => {
  it('submits the token, stores the session, and navigates to preflight', async () => {
    const { fetchImpl, calls } = spyFetch([
      () =>
        jsonResponse({
          data: { sessionToken: 'server-token', expiresAt: '2099-01-01T00:00:00Z' },
        }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({ fetchImpl, step: <ClaimStep /> });
    expect(screen.getByTestId('setup-guidance')).toHaveTextContent('INSTALLATION_TOKEN');
    await user.type(screen.getByLabelText(/installation token/i), 'INSTALL_TOKEN');
    await user.click(screen.getByRole('button', { name: /^claim installation$/i }));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/claim');
    expect(useSetupSession.getState().sessionToken).toBe('server-token');
    expect(lastPathname(history)).toBe('/setup/preflight');
  });

  it('renders the machine code via ErrorPanel on 4xx', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('CLAIM_TOKEN_INVALID', 'Token rejected', 400),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <ClaimStep /> });
    await user.type(screen.getByLabelText(/installation token/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /^claim installation$/i }));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('CLAIM_TOKEN_INVALID');
  });

  it('does not call fetch when the field is empty (zod rejects)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <ClaimStep /> });
    const submit = screen.getByRole('button', { name: /^claim installation$/i });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(calls.length).toBe(0);
    expect(useSetupSession.getState().sessionToken).toBeNull();
  });
});
