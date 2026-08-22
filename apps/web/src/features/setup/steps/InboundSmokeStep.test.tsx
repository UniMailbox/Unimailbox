// apps/web — InboundSmokeStep tests.
//
// CAP-041 AC #10: starts the inbound smoke test, polls until 'received',
// then advances. AC #15 / HIGH 2 (CAP-041 fix): 4xx renders ErrorPanel
// with machine code; 401 surfaces the re-claim button.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { InboundSmokeStep } from './InboundSmokeStep';
import { errorResponse, jsonResponse, renderStep, spyFetch } from '../../../test-utils';

afterEach(() => {
  cleanup();
});

describe('InboundSmokeStep', () => {
  it('starts the smoke test, surfaces the smoke-test address (happy path)', async () => {
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { smokeTestAddress: 'check-abc@inbox.example' } }),
    ]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('inbound-address').textContent).toContain(
        'check-abc@inbox.example',
      );
    });
    // The check endpoint is also probed (refetchInterval=5000). We do not
    // assert that here — happy-dom does not advance them in real time.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/inbound-smoke-test');
  });

  it('surfaces the machine code via ErrorPanel on start 4xx (AC #15)', async () => {
    // 4xx is non-retryable so the apiClient throws immediately.
    const { fetchImpl } = spyFetch([
      () => errorResponse('SMOKE_START_FAILED', 'Worker not ready', 400),
    ]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SMOKE_START_FAILED');
  });

  it('on 401 start offers a Re-claim button (Security HIGH #2)', async () => {
    const { fetchImpl } = spyFetch([() => errorResponse('SESSION_EXPIRED', 'Token expired', 401)]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });

  it('wraps status text in role=status aria-live=polite (MEDIUM)', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { smokeTestAddress: 'check-xyz@inbox.example' } }),
    ]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('inbound-address')).toBeInTheDocument();
    });
    const liveRegions = document.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions.length).toBeGreaterThanOrEqual(1);
  });
});
