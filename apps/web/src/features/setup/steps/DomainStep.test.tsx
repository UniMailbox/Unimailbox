// apps/web — DomainStep tests.
//
// CAP-041 AC #8: POST /api/v1/setup/domain adds the managed domain.
// R-DATA-001: the wizard shows the normalized (lowercased) form. AC #19:
// per-step happy + error path.
//
// CAP-063: the skip affordance's wire behavior lives in
// `use-skip-remaining-setup.test.ts`. The step-level test only asserts
// that the button is rendered (enabled on mount — unlike
// AdministratorStep, the admin already exists by the time the wizard
// reaches this step).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { DomainStep } from './DomainStep';
import {
  errorResponse,
  jsonResponse,
  renderStep,
  spyFetch,
} from '../../../test-utils';

afterEach(() => {
  cleanup();
});

describe('DomainStep', () => {
  it('submits a domain and advances to /setup/cloudflare-verify', async () => {
    const { fetchImpl, calls } = spyFetch([() => jsonResponse({ data: { domainId: 'd-1' } })]);
    const user = (await import('@testing-library/user-event')).default.setup();
    const { history } = await renderStep({ fetchImpl, step: <DomainStep /> });
    await user.type(screen.getByLabelText(/^domain$/i), 'mail.example.com');
    await user.click(screen.getByTestId('domain-submit'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('/api/v1/setup/domain');
    expect(history.location.pathname).toBe('/setup/cloudflare-verify');
  });

  it('displays the lowercased form (R-DATA-001)', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ data: { domainId: 'd-1' } })]);
    const user = (await import('@testing-library/user-event')).default.setup();
    await renderStep({ fetchImpl, step: <DomainStep /> });
    await user.type(screen.getByLabelText(/^domain$/i), 'MAIL.Example.Com');
    // H2 (CAP-041 fix): the previewed normalized form is shown live.
    expect(screen.getByTestId('domain-normalized').textContent).toContain('mail.example.com');
  });

  it('surfaces the machine code via ErrorPanel on 4xx (AC #15)', async () => {
    const { fetchImpl } = spyFetch([() => errorResponse('DOMAIN_INVALID', 'Bad domain', 400)]);
    const user = (await import('@testing-library/user-event')).default.setup();
    await renderStep({ fetchImpl, step: <DomainStep /> });
    await user.type(screen.getByLabelText(/^domain$/i), 'mail.example.com');
    await user.click(screen.getByTestId('domain-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('DOMAIN_INVALID');
  });

  it('on 401 offers a Re-claim button (Security HIGH #2)', async () => {
    const { fetchImpl } = spyFetch([() => errorResponse('SESSION_EXPIRED', 'Token expired', 401)]);
    const user = (await import('@testing-library/user-event')).default.setup();
    await renderStep({ fetchImpl, step: <DomainStep /> });
    await user.type(screen.getByLabelText(/^domain$/i), 'mail.example.com');
    await user.click(screen.getByTestId('domain-submit'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SESSION_EXPIRED');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });

  // CAP-063 AC-3: skip button is rendered + enabled on mount. Wire
  // behavior is owned by `use-skip-remaining-setup.test.ts`.
  it('renders the skip button enabled on mount (AC-3)', async () => {
    const { fetchImpl } = spyFetch([]);
    await renderStep({ fetchImpl, step: <DomainStep /> });
    const skip = await screen.findByTestId('setup-skip-remaining');
    expect(skip).toBeEnabled();
    expect(skip.textContent).toBe('Skip remaining setup');
  });
});