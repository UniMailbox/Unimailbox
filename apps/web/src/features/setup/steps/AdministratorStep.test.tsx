// apps/web — AdministratorStep tests.
//
// CAP-041 AC #7: POST /api/v1/setup/administrator creates the initial
// administrator. AC #15: 4xx returns ErrorPanel with machine code.
// AC #19: per-step happy + error path.
//
// CAP-063: the skip affordance's wire behavior lives in
// `use-skip-remaining-setup.test.ts`. The step-level tests keep the
// gating behavior (D-CAP-063-2) — that's the only step-specific
// concern not covered by the shared hook.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoute } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { InstallationStateInfo } from '@unimailbox/contracts';
import { AdministratorStep } from './AdministratorStep';
import { setupQueryKeys } from '../setup-queries';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  mountAppRouter,
  renderStep,
  spyFetch,
} from '../../../test-utils';

afterEach(() => {
  cleanup();
});

// CAP-063 / D-CAP-063-2: the gating tests need the QueryClient (to seed
// the setup-status cache the way the router's `requireSetupStep` does).
// `renderStep` exposes neither, so these mount through `mountAppRouter`.
async function mountSkipHarness(options: {
  fetchImpl: typeof fetch;
}): Promise<{
  history: Awaited<ReturnType<typeof mountAppRouter>>['history'];
  queryClient: QueryClient;
}> {
  const mounted = await mountAppRouter({
    fetchImpl: options.fetchImpl,
    initialEntries: ['/setup/administrator'],
    buildRouteTree: (rootRoute) => {
      const landingRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <div data-testid="arrived-app">app</div>,
      });
      const administratorRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/setup/administrator',
        component: () => <AdministratorStep />,
      });
      const domainRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/setup/domain',
        component: () => <div data-testid="arrived-domain">domain</div>,
      });
      return rootRoute.addChildren([landingRoute, administratorRoute, domainRoute]);
    },
  });
  return { history: mounted.history, queryClient: mounted.queryClient };
}

describe('AdministratorStep', () => {
  it('submits email + password, advances to /setup/domain (happy path)', async () => {
    const { fetchImpl, calls } = spyFetch([() => jsonResponse({ data: { userId: 'u-1' } })]);
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


  // CAP-063 AC-1 / D-CAP-063-2.
  it('renders the skip button disabled on initial render (AC-1)', async () => {
    const { fetchImpl } = spyFetch([]);
    await renderStep({ fetchImpl, step: <AdministratorStep /> });
    const skip = screen.getByTestId('setup-skip-remaining');
    expect(skip).toBeInTheDocument();
    expect(skip).toBeDisabled();
    expect(skip.textContent).toBe('Skip remaining setup');
  });

  // CAP-063 AC-2. The button is gated on server truth, not only on local
  // state: a successful admin POST navigates to /setup/domain and unmounts
  // this component, so local state alone cannot answer "does an admin
  // exist?" for an operator who navigates back. `currentStep` past
  // `administrator` is that proof, and the router already put it in the
  // cache (`requireSetupStep`).
  it('enables skip when the server reports a step past administrator (AC-2)', async () => {
    const { fetchImpl } = spyFetch([]);
    const { queryClient } = await mountSkipHarness({ fetchImpl });
    expect(screen.getByTestId('setup-skip-remaining')).toBeDisabled();

    queryClient.setQueryData(setupQueryKeys.status(), {
      status: 'setup',
      currentStep: 'domain',
    } satisfies InstallationStateInfo);

    await waitFor(() => {
      expect(screen.getByTestId('setup-skip-remaining')).toBeEnabled();
    });
  });

  // The inverse of AC-2. R-AUTH-005: completing with no administrator
  // leaves nobody able to sign in, so while the server still reports
  // `administrator` the skip must stay blocked.
  it('keeps skip disabled while the server still reports the administrator step', async () => {
    const { fetchImpl } = spyFetch([]);
    const { queryClient } = await mountSkipHarness({ fetchImpl });
    queryClient.setQueryData(setupQueryKeys.status(), {
      status: 'setup',
      currentStep: 'administrator',
    } satisfies InstallationStateInfo);

    await waitFor(() => {
      expect(screen.getByTestId('setup-skip-remaining')).toBeDisabled();
    });
  });
});