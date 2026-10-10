// apps/web — InboundSmokeStep tests.
//
// CAP-041 AC #10: starts the inbound smoke test, polls until 'received',
// then advances. AC #15 / HIGH 2 (CAP-041 fix): 4xx renders ErrorPanel
// with machine code; 401 surfaces the re-claim button.
//
// CAP-063: the skip affordance's wire behavior lives in
// `use-skip-remaining-setup.test.ts`. The step-level test only asserts
// that the button is rendered (enabled on mount — this step polls every
// 5s waiting for a message that may never arrive, so skip must NOT be
// gated on that poll).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { InboundSmokeStep } from './InboundSmokeStep';
import { errorResponse, jsonResponse, renderStep, spyFetch } from '../../../test-utils';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('InboundSmokeStep', () => {
  it('stops after expiry, restarts explicitly, then confirms receipt once with POST', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { smokeTestAddress: 'old@example.com' } }),
      () => jsonResponse({ data: { status: 'expired' } }),
      () => jsonResponse({ data: { smokeTestAddress: 'new@example.com' } }),
      () => jsonResponse({ data: { status: 'received' } }),
      () => jsonResponse({ data: { status: 'received' } }),
    ]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    await screen.findByTestId('inbound-expired');
    expect(calls[1]?.method).toBe('GET');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(calls).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Restart test' }));
    await screen.findByTestId('arrived-brevo');
    expect(calls.map(({ method }) => method)).toEqual(['POST', 'GET', 'POST', 'GET', 'POST']);
  });

  it('stops polling on terminal errors and avoids polling an already expired address', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { smokeTestAddress: 'error@example.com' } }),
      () => errorResponse('SETUP_SESSION_INVALID', 'Session expired', 401),
    ]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    await screen.findByTestId('error-code');
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(calls).toHaveLength(2);
    cleanup();
    const expired = spyFetch([
      () =>
        jsonResponse({
          data: { smokeTestAddress: 'expired@example.com', expiresAt: '2000-01-01T00:00:00Z' },
        }),
    ]);
    await renderStep({ fetchImpl: expired.fetchImpl, step: <InboundSmokeStep /> });
    await screen.findByTestId('inbound-expired');
    expect(expired.calls).toHaveLength(1);
  });

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

  // CAP-063 AC-3: skip button is rendered + enabled on mount. Wire
  // behavior is owned by `use-skip-remaining-setup.test.ts`.
  it('renders the skip button enabled on mount (AC-3)', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { smokeTestAddress: 'check-abc@inbox.example' } }),
    ]);
    await renderStep({ fetchImpl, step: <InboundSmokeStep /> });
    const skip = await screen.findByTestId('setup-skip-remaining');
    expect(skip).toBeEnabled();
    expect(skip.textContent).toBe('Skip remaining setup');
  });
});
