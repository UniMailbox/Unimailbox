// apps/web — useSkipRemainingSetup hook tests.
//
// CAP-063: this is the single source of truth for the skip affordance's
// wire behavior (AC-4, AC-5, AC-6). The six per-step tests cover only
// the gating + button-rendering concerns that are step-specific; the
// POST shape, Idempotency-Key on the wire, navigation on success, error
// rendering, and 401 re-claim all live here. R-WORKFLOW-002: the skip
// reuses the existing /complete endpoint so the state flip stays one D1
// batch with its `setup.complete` audit row.
//
// ADR-004: the API client (`infrastructure/api/client.ts`) auto-sets
// Idempotency-Key for every non-GET/HEAD request. The hook never sets
// the header itself; this test asserts what reaches the wire, not what
// the hook set.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
} from '@tanstack/react-router';
import { createApiClient, type ApiClient } from '../../infrastructure/api/client';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { useSkipRemainingSetup } from './use-skip-remaining-setup';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
} from '../../test-utils';

afterEach(() => {
  cleanup();
});

// Capture every request's URL, method, headers, and body so the test can
// assert wire-level concerns (Idempotency-Key, body shape, no API-key
// leakage). Each resolver returns one Response; subsequent calls reuse
// the last. Returns both a fetchImpl (raw) and an ApiClient built on
// top — tests that need to assert wire shape use fetchImpl, tests that
// need to invoke the hook use the ApiClient.
function spyFetchWithHeaders(resolvers: Array<() => Response>): {
  fetchImpl: typeof fetch;
  apiClient: ApiClient;
  calls: Array<{ url: string; method: string; headers: Headers; body: string | null }>;
} {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];
  let index = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const resolver = resolvers[Math.min(index, resolvers.length - 1)];
    if (resolver === undefined) return new Response('', { status: 599 });
    if (index < resolvers.length - 1) index += 1;
    return resolver();
  };
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, apiClient, calls };
}

// Harness A: no router. Asserts wire shape + error state directly.
// The provider sits OUTSIDE Harness so the hook's `useApiClient` finds it.
function HarnessInner(): React.ReactElement {
  const skip = useSkipRemainingSetup();
  return (
    <div>
      <button
        type="button"
        data-testid="trigger"
        disabled={skip.submitting}
        onClick={() => void skip.skip()}
      >
        skip
      </button>
      {skip.error !== null ? (
        <div data-testid="error-panel">
          <span data-testid="error-code">{skip.error.code}</span>
          <span data-testid="error-status">{String(skip.error.status)}</span>
          <button type="button" data-testid="retry">
            {skip.isUnauthorized ? 'Re-claim installation token' : 'Retry'}
          </button>
        </div>
      ) : null}
      <span data-testid="submitting">{String(skip.submitting)}</span>
      <span data-testid="unauthorized">{String(skip.isUnauthorized)}</span>
    </div>
  );
}

function Harness({ apiClient }: { readonly apiClient: ApiClient }): React.ReactElement {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiClientProvider client={apiClient}>
        <HarnessInner />
      </ApiClientProvider>
    </QueryClientProvider>
  );
}

// Harness B: real TanStack Router tree so we can observe navigation.
// Builds a one-shot tree with a `/setup/start` page that triggers skip
// and a `/` landing page that the hook navigates to on success.
async function renderWithRouter(
  apiClient: ApiClient,
): Promise<ReturnType<typeof createMemoryHistory>> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const landing = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="arrived-landing">landing</div>,
  });
  const start = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/start',
    component: () => {
      const skip = useSkipRemainingSetup();
      return (
        <button
          type="button"
          data-testid="trigger"
          disabled={skip.submitting}
          onClick={() => void skip.skip()}
        >
          skip
        </button>
      );
    },
  });
  const history = createMemoryHistory({ initialEntries: ['/setup/start'] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([landing, start]),
    history,
  });
  await router.load();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return history;
}

describe('useSkipRemainingSetup — wire behavior', () => {
  it('POSTs /setup/complete with empty body and Idempotency-Key (AC-4)', async () => {
    const { apiClient, calls } = spyFetchWithHeaders([
      () => jsonResponse({ data: { status: 'complete' } }),
    ]);
    const user = userEvent.setup();
    render(<Harness apiClient={apiClient} />);
    await user.click(screen.getByTestId('trigger'));

    const skipCall = calls.find((call) => call.url === '/api/v1/setup/complete');
    expect(skipCall).toBeDefined();
    expect(skipCall?.method).toBe('POST');
    expect(skipCall?.body).toBe('{}');
    // ADR-004: the API client sets this for every non-GET/HEAD request.
    expect(skipCall?.headers.get('Idempotency-Key')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('submitting').textContent).toBe('false');
    });
  });

  it('exposes error state on a non-2xx response (AC-6)', async () => {
    const { apiClient } = spyFetchWithHeaders([
      () => errorResponse('SETUP_ALREADY_COMPLETE', 'Installation already complete', 409),
    ]);
    const user = userEvent.setup();
    render(<Harness apiClient={apiClient} />);
    await user.click(screen.getByTestId('trigger'));
    const code = await screen.findByTestId('error-code');
    expect(code.textContent).toBe('SETUP_ALREADY_COMPLETE');
    expect(screen.getByTestId('error-status').textContent).toBe('409');
    expect(screen.getByTestId('unauthorized').textContent).toBe('false');
  });

  it('flips isUnauthorized to true on 401 (AC-6)', async () => {
    const { apiClient } = spyFetchWithHeaders([
      () => errorResponse('SETUP_CLAIM_INVALID_TOKEN', 'Token no longer valid', 401),
    ]);
    const user = userEvent.setup();
    render(<Harness apiClient={apiClient} />);
    await user.click(screen.getByTestId('trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('unauthorized').textContent).toBe('true');
    });
    expect(screen.getByTestId('error-code').textContent).toBe('SETUP_CLAIM_INVALID_TOKEN');
    expect(
      screen.getByRole('button', { name: /re-claim installation token/i }),
    ).toBeInTheDocument();
  });

  it('ignores re-entrant calls while submitting (no double-POST)', async () => {
    const pending: { resolve: () => void } = { resolve: () => undefined };
    let callCount = 0;
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/v1/setup/complete') {
        callCount += 1;
        await new Promise<void>((resolve) => {
          pending.resolve = resolve;
        });
        return jsonResponse({ data: { status: 'complete' } });
      }
      return new Response('', { status: 599 });
    };
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const user = userEvent.setup();
    render(<Harness apiClient={apiClient} />);
    // Fire two clicks back-to-back while the first is in flight.
    const trigger = screen.getByTestId('trigger');
    await user.click(trigger);
    await user.click(trigger);
    // Yield so any queued second call would have run.
    await new Promise((r) => setTimeout(r, 0));
    pending.resolve();
    await waitFor(() => {
      expect(screen.getByTestId('submitting').textContent).toBe('false');
    });
    // The first call is the only one — second click was a no-op because
    // the hook was already submitting.
    expect(callCount).toBe(1);
  });

  it('reuses one /complete URL across calls — does not send any other endpoint', async () => {
    const { apiClient, calls } = spyFetchWithHeaders([
      () => jsonResponse({ data: { status: 'complete' } }),
    ]);
    const user = userEvent.setup();
    render(<Harness apiClient={apiClient} />);
    await user.click(screen.getByTestId('trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('submitting').textContent).toBe('false');
    });
    // R-SECRET-003 / R-WORKFLOW-002: only /complete. No outbound-smoke,
    // no Brevo, no anything else.
    const urls = calls.map((c) => c.url);
    expect(urls.every((u) => u === '/api/v1/setup/complete')).toBe(true);
  });

  it('does not leak previous secrets into the skip body (R-SECRET-003)', async () => {
    const { apiClient, calls } = spyFetchWithHeaders([
      () => jsonResponse({ data: { status: 'complete' } }),
    ]);
    const user = userEvent.setup();
    render(<Harness apiClient={apiClient} />);
    await user.click(screen.getByTestId('trigger'));
    await waitFor(() => {
      expect(screen.getByTestId('submitting').textContent).toBe('false');
    });
    const skipCall = calls.find((call) => call.url === '/api/v1/setup/complete');
    expect(skipCall?.body).toBe('{}');
    expect(skipCall?.body).not.toContain('xkeysib');
    expect(skipCall?.body).not.toContain('apiKey');
  });
});

describe('useSkipRemainingSetup — navigation', () => {
  it('navigates to / after a successful /complete (AC-5)', async () => {
    const { apiClient } = spyFetchWithHeaders([
      () => jsonResponse({ data: { status: 'complete' } }),
    ]);
    const history = await renderWithRouter(apiClient);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('trigger'));
    await waitFor(() => {
      expect(lastPathname(history)).toBe('/');
    });
  });
});