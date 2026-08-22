// apps/web — AdministratorStep tests.
//
// CAP-041 AC #7: POST /api/v1/setup/administrator creates the initial
// administrator. AC #15: 4xx returns ErrorPanel with machine code.
// AC #19: per-step happy + error path.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdministratorStep } from './AdministratorStep';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  renderStep,
  spyFetch,
} from '../../../test-utils';

afterEach(() => {
  cleanup();
});

describe('AdministratorStep', () => {
  it('submits email + password, advances to /setup/domain (happy path)', async () => {
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { userId: 'u-1' } }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({
      fetchImpl,
      step: <AdministratorStep />,
    });
    await user.type(screen.getByLabelText(/^email$/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'correct-horse-battery');
    await user.click(screen.getByTestId('administrator-submit'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/administrator');
    expect(lastPathname(history)).toBe('/setup/domain');
  });

  it('surfaces the machine code via ErrorPanel on 4xx (AC #15)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('EMAIL_TAKEN', 'Email already registered', 409),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <AdministratorStep /> });
    await user.type(screen.getByLabelText(/^email$/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'correct-horse-battery');
    await user.click(screen.getByTestId('administrator-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('EMAIL_TAKEN');
  });

  it('does not call fetch when validation fails (zod rejects)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <AdministratorStep /> });
    await user.type(screen.getByLabelText(/^password$/i), 'short');
    await user.click(screen.getByTestId('administrator-submit'));
    expect(calls.length).toBe(0);
  });

  it('on 401 offers a Re-claim button (Security HIGH #2)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('SESSION_EXPIRED', 'Token no longer valid', 401),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <AdministratorStep /> });
    await user.type(screen.getByLabelText(/^email$/i), 'admin@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'correct-horse-battery');
    await user.click(screen.getByTestId('administrator-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });
});