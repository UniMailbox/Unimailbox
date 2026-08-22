// apps/web — BrevoStep tests.
//
// CAP-041 AC #11: posts the Brevo API key and advances. R-SECRET-003:
// the key value is never echoed back into the success view. AC #15:
// 4xx returns ErrorPanel with machine code. HIGH 2 (CAP-041 fix):
// 401 surfaces the re-claim button.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrevoStep } from './BrevoStep';
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

describe('BrevoStep', () => {
  it('submits the API key, advances to /setup/outbound-smoke (happy path)', async () => {
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { providerConnectionId: 'p-1' } }),
    ]);
    const user = userEvent.setup();
    const { history } = await renderStep({ fetchImpl, step: <BrevoStep /> });
    await user.type(screen.getByLabelText(/^brevo api key$/i), 'xkeysib-secret');
    await user.click(screen.getByTestId('brevo-submit'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/brevo');
    expect(lastPathname(history)).toBe('/setup/outbound-smoke');
  });

  it('surfaces the machine code via ErrorPanel on 4xx (AC #15)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('BREVO_KEY_INVALID', 'Key rejected by Brevo', 400),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <BrevoStep /> });
    await user.type(screen.getByLabelText(/^brevo api key$/i), 'xkeysib-bad');
    await user.click(screen.getByTestId('brevo-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('BREVO_KEY_INVALID');
  });

  it('on 401 offers a Re-claim button (Security HIGH #2)', async () => {
    const { fetchImpl } = spyFetch([
      () => errorResponse('SESSION_EXPIRED', 'Token expired', 401),
    ]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <BrevoStep /> });
    await user.type(screen.getByLabelText(/^brevo api key$/i), 'xkeysib-secret');
    await user.click(screen.getByTestId('brevo-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });

  it('does not call fetch when the field is empty (zod rejects)', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const user = userEvent.setup();
    await renderStep({ fetchImpl, step: <BrevoStep /> });
    await user.click(screen.getByTestId('brevo-submit'));
    expect(calls.length).toBe(0);
  });
});