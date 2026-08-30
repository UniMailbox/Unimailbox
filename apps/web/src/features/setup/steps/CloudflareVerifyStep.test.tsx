// apps/web — CloudflareVerifyStep tests.
//
// CAP-041 AC #9: opens the Cloudflare dashboard link, lets the operator
// confirm, then POSTs /cloudflare/verify and advances to /setup/inbound-smoke.
// MEDIUM (CAP-041 fix): when window.open returns null the confirm button
// stays disabled. AC #19: per-step happy + error path.
//
// CAP-063: the skip affordance's wire behavior lives in
// `use-skip-remaining-setup.test.ts`. The step-level test only asserts
// that the button is rendered enabled even when the Cloudflare popup
// is blocked (an operator who cannot open the dashboard is exactly
// the one who needs to skip).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CloudflareVerifyStep } from './CloudflareVerifyStep';
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

describe('CloudflareVerifyStep', () => {
  beforeEach(() => {
    // happy-dom's default `window.open` returns a no-op Window — the
    // step component treats null as the popup-blocked signal, so we
    // stub it per test as needed.
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  it('opens the dashboard link, confirms, and advances (happy path)', async () => {
    const openedSpy = vi.spyOn(window, 'open').mockReturnValue(window as unknown as Window);
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { url: 'https://example.cloudflare.com' } }),
      () => jsonResponse({ data: {} }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({
      fetchImpl,
      step: <CloudflareVerifyStep />,
    });
    await waitFor(() => {
      expect(openedSpy).toHaveBeenCalledWith(
        'https://example.cloudflare.com',
        '_blank',
        'noopener,noreferrer',
      );
    });
    expect(screen.getByTestId('cloudflare-opened')).toBeInTheDocument();
    await user.click(screen.getByTestId('cloudflare-confirm'));
    expect(calls.length).toBe(2);
    expect(lastPathname(history)).toBe('/setup/inbound-smoke');
  });

  it('disables the confirm button when the popup is blocked (MEDIUM)', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { url: 'https://example.cloudflare.com' } }),
    ]);
    await renderStep({ fetchImpl, step: <CloudflareVerifyStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('cloudflare-popup-blocked')).toBeInTheDocument();
    });
    expect(screen.getByTestId('cloudflare-confirm')).toBeDisabled();
  });

  it('surfaces the machine code via ErrorPanel on verify 4xx (AC #15)', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window as unknown as Window);
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { url: 'https://example.cloudflare.com' } }),
      () => errorResponse('CF_NOT_VERIFIED', 'Not configured', 400),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <CloudflareVerifyStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('cloudflare-opened')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('cloudflare-confirm'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('CF_NOT_VERIFIED');
  });

  it('on 401 verify offers a Re-claim button (Security HIGH #2)', async () => {
    vi.spyOn(window, 'open').mockReturnValue(window as unknown as Window);
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { url: 'https://example.cloudflare.com' } }),
      () => errorResponse('SESSION_EXPIRED', 'Token expired', 401),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <CloudflareVerifyStep /> });
    await waitFor(() => {
      expect(screen.getByTestId('cloudflare-opened')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('cloudflare-confirm'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });

  // CAP-063 AC-3. The skip button stays enabled even when the popup
  // is blocked — gating skip on the dashboard link would be the wrong
  // direction (a blocked popup is exactly the case where the operator
  // wants to skip).
  it('renders the skip button enabled on mount, even when the popup is blocked (AC-3)', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { url: 'https://dash.cloudflare.com/x' } }),
    ]);
    await renderStep({ fetchImpl, step: <CloudflareVerifyStep /> });
    const skip = await screen.findByTestId('setup-skip-remaining');
    expect(skip).toBeEnabled();
    expect(skip.textContent).toBe('Skip remaining setup');
    // window.open is stubbed to null in beforeEach → popup blocked.
    expect(screen.getByTestId('cloudflare-confirm')).toBeDisabled();
  });
});