// apps/web — OutboundSmokeStep tests.
//
// CAP-041 AC #12: POST /api/v1/setup/outbound-smoke-test, then advances
// to /setup/complete. AC #15: 4xx returns ErrorPanel with machine code.
// HIGH 2 (CAP-041 fix): 401 surfaces the re-claim button.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutboundSmokeStep } from './OutboundSmokeStep';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  renderStep,
  spyFetch,
} from '../../../test-utils';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OutboundSmokeStep', () => {
  it('submits the smoke test, advances to /setup/complete (happy path)', async () => {
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { ok: true } }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({
      fetchImpl,
      step: <OutboundSmokeStep />,
    });
    await user.click(screen.getByTestId('outbound-submit'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/outbound-smoke-test');
    await waitFor(() => {
      expect(lastPathname(history)).toBe('/setup/complete');
    });
  });

  it('surfaces the machine code via ErrorPanel on 4xx (AC #15)', async () => {
    // 4xx is non-retryable so the apiClient throws immediately and the
    // ErrorPanel surfaces the machine code without timer fiddling.
    const { fetchImpl } = spyFetch([
      () => errorResponse('OUTBOUND_FAILED', 'Send failed', 400),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <OutboundSmokeStep /> });
    await user.click(screen.getByTestId('outbound-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('OUTBOUND_FAILED');
  });

  it('on 401 offers a Re-claim button (Security HIGH #2)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('SESSION_EXPIRED', 'Token expired', 401),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <OutboundSmokeStep /> });
    await user.click(screen.getByTestId('outbound-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });
});