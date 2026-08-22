// apps/web — CompleteStep tests.
//
// CAP-041 AC #13: POST /api/v1/setup/complete flips
// installation_state.status to 'complete'. The success view shows a
// "Go to app" link to /. AC #15: 4xx returns ErrorPanel with machine
// code. HIGH 2 (CAP-041 fix): 401 surfaces the re-claim button.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompleteStep } from './CompleteStep';
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

describe('CompleteStep', () => {
  it('submits the final POST, shows success card, and exposes Go to app (happy path)', async () => {
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { status: 'complete' } }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({
      fetchImpl,
      step: <CompleteStep />,
    });
    await user.click(screen.getByTestId('complete-submit'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/complete');
    await waitFor(() => {
      expect(screen.getByTestId('complete-success')).toBeInTheDocument();
    });
    expect(screen.getByTestId('complete-go-to-app')).toBeInTheDocument();
    await user.click(screen.getByTestId('complete-go-to-app'));
    expect(lastPathname(history)).toBe('/');
  });

  it('surfaces the machine code via ErrorPanel on 4xx (AC #15)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('COMPLETE_BLOCKED', 'Inbound not received', 409),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <CompleteStep /> });
    await user.click(screen.getByTestId('complete-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('COMPLETE_BLOCKED');
  });

  it('on 401 offers a Re-claim button (Security HIGH #2)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('SESSION_EXPIRED', 'Token expired', 401),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <CompleteStep /> });
    await user.click(screen.getByTestId('complete-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });
});