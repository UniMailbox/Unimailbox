// apps/web — AppNav tests.
//
// CAP-044 Slice 3 amendment item 1 (D-CAP-044-K). The nav probe contract:
//
//   - Probe 200 → the Admin link renders and points at /admin.
//   - Probe 403 (the member surface) → NOTHING renders — no skeleton, no
//     "Admin (unavailable)".
//   - Exactly ONE probe request per signed-in userId: retry +
//     retryOnMount false and staleTime + gcTime Infinity mean a remount
//     (a navigation away and back) serves the cached verdict without a
//     refetch — for a GRANTED probe (staleTime cache hit) AND a denied
//     one (an errored query TanStack would otherwise refetch on every
//     observer remount — fix (c)).
//   - No session → the probe is disabled: zero requests (the login shell
//     stays request-free).
//
// The probe hits `GET /api/v1/admin/audit-events?limit=1` (the cheapest
// admin-scoped authorization check; the payload is never parsed).
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from '@tanstack/react-router';
import { ApiClientProvider } from '../infrastructure/api/client-provider';
import { createApiClient } from '../infrastructure/api/client';
import { authQueryKeys } from '../features/auth/auth-queries';
import { resetAuthSessionForTesting } from '../features/auth/auth-session-store';
import { AppNav } from './AppNav';
import { errorResponse, jsonResponse, spyFetch } from '../test-utils';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

const SESSION = {
  userId: 'u-1',
  email: 'a@b.test',
  displayName: 'A B',
  expiresAt: '2099-01-01T00:00:00Z',
};

const PROBE_URL = '/api/v1/admin/audit-events?limit=1';

function authSessionResolver(): Response {
  return jsonResponse({
    data: {
      user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
      session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
    },
  });
}

interface MountOptions {
  /** The response every probe request receives. */
  readonly probeResponse: () => Response;
  /** Pre-seeded session: SESSION (signed in), null (signed out), or undefined (loading). */
  readonly session?: unknown;
}

/**
 * Mounts AppNav on two routes ('/here' and '/there') in a memory-history
 * router so the test can navigate away and back — the remount path the
 * one-probe assertion needs. The get-session refetch (staleTime 0) is
 * URL-dispatched so it never consumes the probe's resolver slot.
 */
function mountAppNav(options: MountOptions): {
  fetchCalls: Array<{ url: string; method: string }>;
} {
  const { fetchImpl: sequentialFetch, calls } = spyFetch([options.probeResponse]);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      calls.push({ url, method: 'GET' });
      return authSessionResolver();
    }
    return sequentialFetch(input, init);
  };
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  // Omit `session` entirely to model a still-loading session (probe
  // disabled via `enabled`); `null` models signed-out (also disabled).
  if (options.session !== undefined) {
    queryClient.setQueryData(authQueryKeys.session(), options.session);
  }
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const hereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/here',
    component: () => {
      const navigate = useNavigate();
      return (
        <div>
          <AppNav />
          <button
            type="button"
            data-testid="go-there"
            onClick={() => {
              void navigate({ to: '/there' });
            }}
          >
            go there
          </button>
        </div>
      );
    },
  });
  const thereRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/there',
    // The wrapper testid proves the navigation actually happened — the
    // AppNav inside is a FRESH mount on this route, not the /here
    // instance carried over. That is what the denied-remount test below
    // needs to be a real unmount → remount.
    component: () => (
      <div data-testid="on-there">
        <AppNav />
      </div>
    ),
  });
  // '/admin' sentinel so AppNav's <Link to="/admin"> resolves.
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    component: () => <div data-testid="arrived-admin">admin</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([hereRoute, thereRoute, adminRoute]),
    history: createMemoryHistory({ initialEntries: ['/here'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { fetchCalls: calls };
}

function probeCount(calls: ReadonlyArray<{ url: string; method: string }>): number {
  return calls.filter((call) => call.method === 'GET' && call.url.includes(PROBE_URL)).length;
}

describe('AppNav (CAP-044 Slice 3 / D-CAP-044-K)', () => {
  it('renders the Admin link when the probe succeeds', async () => {
    const { fetchCalls } = mountAppNav({
      probeResponse: () => jsonResponse({ data: { items: [], nextCursor: null } }),
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('app-nav')).toBeInTheDocument();
    });
    const link = screen.getByTestId('app-nav-admin-link');
    expect(link.getAttribute('href')).toBe('/admin');
    expect(link.textContent).toBe('Admin');
    expect(probeCount(fetchCalls)).toBe(1);
  });

  it('renders nothing for a member (probe 403), and exactly one probe request fires', async () => {
    const { fetchCalls } = mountAppNav({
      probeResponse: () => errorResponse('PERMISSION_DENIED', 'Forbidden', 403),
      session: SESSION,
    });
    // Give the denied probe a tick to resolve; absence is the member's
    // steady state — no skeleton, no fallback text.
    await waitFor(() => {
      expect(probeCount(fetchCalls)).toBe(1);
    });
    expect(screen.queryByTestId('app-nav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-nav-admin-link')).not.toBeInTheDocument();
    // No retry: the count stays one.
    expect(probeCount(fetchCalls)).toBe(1);
  });

  it('fires exactly one probe across a remount (staleTime Infinity)', async () => {
    const { fetchCalls } = mountAppNav({
      probeResponse: () => jsonResponse({ data: { items: [], nextCursor: null } }),
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('app-nav-admin-link')).toBeInTheDocument();
    });
    expect(probeCount(fetchCalls)).toBe(1);

    // Navigate away (AppNav unmounts) and the verdict travels with the
    // cache — the remounted AppNav must NOT refire the probe.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('go-there'));
    await waitFor(() => {
      expect(screen.getByTestId('app-nav-admin-link')).toBeInTheDocument();
    });
    expect(probeCount(fetchCalls)).toBe(1);
  });

  it('fix (c): a DENIED probe does not refetch on remount — 403, unmount, remount, still one request', async () => {
    const { fetchCalls } = mountAppNav({
      probeResponse: () => errorResponse('PERMISSION_DENIED', 'Forbidden', 403),
      session: SESSION,
    });
    await waitFor(() => {
      expect(probeCount(fetchCalls)).toBe(1);
    });
    expect(screen.queryByTestId('app-nav')).not.toBeInTheDocument();

    // Navigate away (the /here AppNav unmounts; a fresh one mounts on
    // /there). A denied probe is an ERRORED query — without
    // retryOnMount: false TanStack refetches an errored query on every
    // observer remount, turning "one 403 per session" into one per
    // navigation. This test pins the fix.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('go-there'));
    await waitFor(() => {
      expect(screen.getByTestId('on-there')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('app-nav-admin-link')).not.toBeInTheDocument();
    expect(probeCount(fetchCalls)).toBe(1);
  });

  it('fires no probe at all without a session (probe disabled)', async () => {
    const { fetchCalls } = mountAppNav({
      probeResponse: () => jsonResponse({ data: { items: [], nextCursor: null } }),
      session: null,
    });
    // Signed out: enabled === false, so nothing renders and nothing is
    // requested. Wait a tick so a would-be fetch could have fired.
    await waitFor(() => {
      expect(screen.queryByTestId('app-nav')).not.toBeInTheDocument();
    });
    expect(probeCount(fetchCalls)).toBe(0);
  });
});
