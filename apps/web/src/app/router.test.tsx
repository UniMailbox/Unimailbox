// apps/web — router-context tests.
//
// CAP-042 (Batch 5) D-CAP-041-9 closure: at least one real
// router-context test that mounts the router and asserts the
// `/mailbox` `beforeLoad` redirects to `/login` when no session
// exists.
//
// This test is the load-bearing closure for the D-CAP-041-9 deferred
// item from CAP-041 (`test-utils.tsx`'s `mountAppRouter` helper existed
// for exactly this purpose but no test was exercising it). The route
// tree mirrors the production routes — `/login`, `/register`, `/mailbox`
// with the same `beforeLoad` shape — so a future regression in the
// router's cache-backed `beforeLoad` path will be caught here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createMemoryHistory,
  createRoute,
  RouterProvider,
  type RootRoute,
  type AnyRoute,
  redirect,
} from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { jsonResponse, lastPathname, mountAppRouter, spyFetch } from '../test-utils';
import { createAppRouter, validateComposeSearch, validateFolderSearch } from './router';
import type { RouterContext } from './router';
import { authQueryKeys, fetchAuthSession } from '../features/auth/auth-queries';
import { setupQueryKeys } from '../features/setup/setup-queries';
import { createApiClient } from '../infrastructure/api/client';
import { ApiClientProvider } from '../infrastructure/api/client-provider';
import {
  clearSetupSession,
  setSetupSession,
  useSetupSession,
} from '../features/setup/setup-session-store';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Build the same `/mailbox` `beforeLoad` shape the production router
// uses. A reviewer reading this file should be able to map the lines
// back to `app/router.tsx` 1:1.
function buildAuthRouteTree(
  rootRoute: RootRoute<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    undefined,
    RouterContext
  >,
): AnyRoute {
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const registerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/register',
    component: () => <div data-testid="arrived-register">register</div>,
  });
  const mailboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-mailbox">mailbox</div>,
  });
  return rootRoute.addChildren([loginRoute, registerRoute, mailboxRoute]);
}

describe('router (D-CAP-041-9 closure)', () => {
  it('redirects /mailbox to /login when there is no session', async () => {
    // Better Auth returns a `{ data: null }` body (or equivalent) when
    // no cookie is present. `fetchAuthSession` swallows 401s and the
    // unwrapped null body both.
    const { fetchImpl } = spyFetch([() => jsonResponse({ data: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      // No `authSession` fixture — the cache starts empty.
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('redirects /mailbox to /login when get-session returns a null user', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ user: null, session: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('renders /mailbox when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      authSession: {
        userId: 'u-pre',
        email: 'pre@b.test',
        displayName: 'Pre',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/mailbox');
    // No additional fetch — the cache was already warm.
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CAP-041 preflight hotfix — AC-1 (active chip on first render) + AC-7
// (Continue actually navigates). The previous `requireSetupStep` bypassed
// React Query (called `fetchSetupStatus(apiClient)` directly), so the cache
// was empty when `<SetupLayout>` mounted and every chip rendered as
// `upcoming` on first paint. The fix routes `requireSetupStep` through
// `queryClient.fetchQuery`, which populates it synchronously before the
// layout mounts.
//
// These tests mount the production router (not a mirror tree) so the
// beforeLoad + SetupLayout code paths are exercised exactly as the
// operator sees them.
// ---------------------------------------------------------------------------

describe('router — CAP-041 preflight hotfix (AC-1 + AC-7)', () => {
  // AC-1: loading /setup/preflight while installation_state.current_step
  // is 'preflight' renders the preflight chip as the active step on the
  // very first paint — `data-state="current"` AND `aria-current="step"`.
  // The router's beforeLoad populates the cache via
  // `queryClient.fetchQuery`, so the layout's `setupStatusQuery()`
  // reads the cache synchronously.
  it('AC-1 active chip is correct on first paint when cache is pre-populated', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      // Status endpoint is not actually called (cache is warm), but if
      // the router does call it for any reason the body must agree with
      // the cache entry below — same shape, same values.
      fetchImpl: (async () =>
        jsonResponse({
          data: { status: 'setup', currentStep: 'preflight' },
        })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    // Simulate the cache being populated by the router's beforeLoad —
    // this is the shape `requireSetupStep` now produces via
    // `queryClient.fetchQuery`.
    queryClient.setQueryData(setupQueryKeys.status(), {
      status: 'setup' as const,
      currentStep: 'preflight' as const,
    });
    const history = createMemoryHistory({ initialEntries: ['/setup/preflight'] });
    const router = createAppRouter(apiClient, queryClient, history);
    await router.load();

    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );

    // First paint — no waitFor. The chip must already be `current`.
    const preflightChip = screen.getByTestId('step-preflight');
    expect(preflightChip.getAttribute('data-state')).toBe('current');
    expect(preflightChip.getAttribute('aria-current')).toBe('step');
    // Claim is before preflight in the wizard order → it should be
    // `complete` (not `upcoming`, which was the bug).
    expect(screen.getByTestId('step-claim').getAttribute('data-state')).toBe('complete');
    // Administrator is after preflight → it should be `upcoming`.
    expect(screen.getByTestId('step-administrator').getAttribute('data-state')).toBe('upcoming');
  });

  // AC-1 control: regression guard for the cache-hydration chain. With a
  // cold cache, `requireSetupStep` must populate the cache via
  // `queryClient.fetchQuery` so the chip is correct on first paint —
  // NOT after a useQuery refetch from the layout. A future refactor that
  // bypasses `queryClient.fetchQuery` (e.g. reverting to a direct
  // `fetchSetupStatus(context.apiClient)` call) would reintroduce the
  // all-upcoming flash. We assert on first render WITHOUT `waitFor`
  // because RTL's `render` is a synchronous commit — `waitFor` would
  // mask the bug-class regression we are guarding against.
  it('AC-1 control — cold cache is hydrated by requireSetupStep before first paint', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({
          data: { status: 'setup', currentStep: 'preflight' },
        })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    // Intentionally do NOT pre-seed the cache — this is the regression-
    // guard shape. requireSetupStep (called from beforeLoad) is the
    // only thing allowed to populate it.
    const history = createMemoryHistory({ initialEntries: ['/setup/preflight'] });
    const router = createAppRouter(apiClient, queryClient, history);
    await router.load();

    expect(queryClient.getQueryData(setupQueryKeys.status())).toEqual({
      status: 'setup',
      currentStep: 'preflight',
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );

    // First paint (no waitFor): the preflight chip is `current`, not
    // `upcoming`. If a future refactor skips the fetchQuery hydration,
    // this assertion fails on the first paint and the test reports the
    // regression with file:line.
    expect(screen.getByTestId('step-preflight').getAttribute('data-state')).toBe('current');
    expect(screen.getByTestId('step-claim').getAttribute('data-state')).toBe('complete');
    expect(screen.getByTestId('step-administrator').getAttribute('data-state')).toBe('upcoming');
  });

  // AC-7: after a successful preflight, navigating to /setup/administrator
  // resolves without a redirect bounce. The previous bug: the Continue
  // handler called `navigate({to:'/setup/administrator'})`, the route's
  // beforeLoad → `requireSetupStep` saw `state.currentStep === 'preflight'`
  // and `expectedIndex(2) > activeIndex(1)`, and threw a redirect back to
  // /setup/preflight. With the hotfix, the server-side POST /preflight
  // advances the state and the cache mirrors it, so the navigation
  // resolves cleanly. We simulate the post-advance cache state directly
  // (the actual preflight POST is exercised by the worker-pool tests in
  // preflight.worker.test.ts AC-2/AC-3/AC-4/AC-5/AC-6).
  it('AC-7 after a successful preflight Continue reaches /setup/administrator', async () => {
    // Wire a setup session token so PreflightStep's POST /preflight
    // (if it runs) carries an Authorization header — even though the
    // hotfix path does not require the click to invoke POST again here
    // (we simulate the post-advance state directly).
    setSetupSession('test-session-token');
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => useSetupSession.getState().sessionToken,
      // Mock the preflight endpoint so PreflightStep's `setupPreflightQuery`
      // (which it runs on mount) returns all-green. The endpoint is
      // /api/v1/setup/preflight, accessed as POST.
      fetchImpl: (async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/v1/setup/preflight') && init?.method === 'POST') {
          return jsonResponse({
            data: {
              bindings: {
                DB: true,
                ATTACHMENTS: true,
                SETUP_SESSION: true,
                CACHE: true,
                OUTBOUND: true,
                INSTALLATION_TOKEN: true,
                CREDENTIAL_ENCRYPTION_KEY: true,
                BETTER_AUTH_SECRET: true,
              },
              schemaVersion: CURRENT_SCHEMA_VERSION,
            },
          });
        }
        if (url.endsWith('/api/v1/setup/status')) {
          return jsonResponse({
            data: { status: 'setup', currentStep: 'administrator' },
          });
        }
        return jsonResponse({ data: null }, 404);
      }) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    // Start at the preflight step with cache currentStep='preflight'.
    queryClient.setQueryData(setupQueryKeys.status(), {
      status: 'setup' as const,
      currentStep: 'preflight' as const,
    });
    const history = createMemoryHistory({ initialEntries: ['/setup/preflight'] });
    const router = createAppRouter(apiClient, queryClient, history);
    await router.load();

    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );

    // Wait for PreflightStep's setupPreflightQuery to settle so the
    // Continue button is enabled (all bindings present AND schema OK).
    const continueButton = await screen.findByRole('button', { name: /continue/i });
    await waitFor(() => {
      expect(continueButton).not.toBeDisabled();
    });

    // Simulate the server-side advance the worker test suite proves
    // happens (AC-2): the POST /preflight updates installation_state
    // AND mirrors it into the cache so the layout reflects the new
    // current step on the next render. The router's `beforeLoad`
    // re-runs on every navigation and would refetch, but updating the
    // cache is what the production code path does after a successful
    // mutation (via `queryClient.setQueryData(setupQueryKeys.status(), …)`
    // or `queryClient.invalidateQueries`).
    queryClient.setQueryData(setupQueryKeys.status(), {
      status: 'setup' as const,
      currentStep: 'administrator' as const,
    });

    const user = userEvent.setup();
    await user.click(continueButton);

    // The router must have resolved /setup/administrator, not bounced
    // back to /setup/preflight. The chip indicator reflects the new
    // current step on the next render: preflight → complete,
    // administrator → current.
    await waitFor(() => {
      expect(history.location.pathname).toBe('/setup/administrator');
    });
    expect(screen.getByTestId('step-preflight').getAttribute('data-state')).toBe('complete');
    expect(screen.getByTestId('step-administrator').getAttribute('data-state')).toBe('current');
    // Claim, which is before preflight, stays complete.
    expect(screen.getByTestId('step-claim').getAttribute('data-state')).toBe('complete');

    clearSetupSession();
  });
});

// CAP-041 follow-up (D-CAP-041-H1): the two setup-shim routes
// (`/setup` index + `/setup/$subStep` unknown-step path) now hydrate
// the React Query cache via `context.queryClient.fetchQuery` instead of
// a direct fetch — same shape as `requireSetupStep` and
// `requireCompletedSetup`. These tests pin that contract: a future
// refactor that bypasses the cache again would silently break DRY
// across the three call sites and re-open the chip-flash regression.
describe('router — CAP-041 follow-up H1 (setup shim cache hydration)', () => {
  // Helper: build a router that targets the requested path with a
  // mocked `/api/v1/setup/status` returning the supplied state. Returns
  // the post-`router.load()` cache snapshot for the status key.
  async function loadSetupShimAndReadCache(
    initialPath: '/setup' | '/setup/not-a-real-step',
    currentStep:
      | 'claim'
      | 'preflight'
      | 'administrator'
      | 'domain'
      | 'cloudflare-verify'
      | 'inbound-smoke'
      | 'brevo'
      | 'outbound-smoke'
      | 'complete',
  ) {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({
          data: { status: 'setup', currentStep },
        })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({ initialEntries: [initialPath] });
    const router = createAppRouter(apiClient, queryClient, history);
    await router.load();
    return { queryClient, history, router };
  }

  it('setupIndexRoute.beforeLoad hydrates setupQueryKeys.status()', async () => {
    const { queryClient, history } = await loadSetupShimAndReadCache('/setup', 'administrator');

    // Cache populated by the beforeLoad's fetchQuery call.
    expect(queryClient.getQueryData(setupQueryKeys.status())).toEqual({
      status: 'setup',
      currentStep: 'administrator',
    });
    // And the route shimmed through to the canonical current-step URL.
    expect(history.location.pathname).toBe('/setup/administrator');
  });

  it('unknownSetupStepRoute.beforeLoad hydrates setupQueryKeys.status()', async () => {
    const { queryClient, history } = await loadSetupShimAndReadCache(
      '/setup/not-a-real-step',
      'preflight',
    );

    expect(queryClient.getQueryData(setupQueryKeys.status())).toEqual({
      status: 'setup',
      currentStep: 'preflight',
    });
    // Stale sub-step URL falls back to the server's current step.
    expect(history.location.pathname).toBe('/setup/preflight');
  });
});

describe('router — CAP-062 production draft route', () => {
  it('redirects the root entrypoint to login when there is no session', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (input) => {
        const url = String(input);
        return url.endsWith('/api/v1/setup/status')
          ? jsonResponse({ data: { status: 'complete', currentStep: 'complete' } })
          : jsonResponse({ data: { user: null, session: null } });
      }) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/login');
  });

  it('redirects the root entrypoint to the mailbox shell for an authenticated session', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({ data: { status: 'complete', currentStep: 'complete' } })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    queryClient.setQueryData(authQueryKeys.session(), {
      userId: 'user-root',
      email: 'root@example.test',
      displayName: 'Root User',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/mailbox');
  });

  it('redirects the mailbox entrypoint to the active setup step before auth when setup is incomplete', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({ data: { status: 'setup', currentStep: 'claim' } })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({ initialEntries: ['/mailbox'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/setup/claim');
  });

  it('renders the production Claim step inside the setup layout', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({ data: { status: 'setup', currentStep: 'claim' } })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({ initialEntries: ['/setup/claim'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Claim installation' })).toBeInTheDocument();
    expect(screen.getByTestId('setup-guidance')).toHaveTextContent('INSTALLATION_TOKEN');
  });

  it('recovers an unknown setup URL to the server-selected step', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({ data: { status: 'setup', currentStep: 'claim' } })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({ initialEntries: ['/setup/not-a-step'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/setup/claim');
  });

  it('refreshes a stale incomplete setup cache before allowing the mailbox shell', async () => {
    const { fetchImpl, calls } = spyFetch([
      () => jsonResponse({ data: { status: 'complete', currentStep: 'complete' } }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    queryClient.setQueryData(setupQueryKeys.status(), {
      status: 'setup',
      currentStep: 'claim',
    });
    queryClient.setQueryData(authQueryKeys.session(), {
      userId: 'user-root',
      email: 'root@example.test',
      displayName: 'Root User',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const apiClient = createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl });
    const history = createMemoryHistory({ initialEntries: ['/mailbox'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/mailbox');
    expect(calls).toHaveLength(1);
  });

  it.each([
    '/mailbox/00000000-0000-4000-8000-000000000001',
    '/mailbox/00000000-0000-4000-8000-000000000001/messages/00000000-0000-4000-8000-000000000002',
    '/mailbox/00000000-0000-4000-8000-000000000001/compose',
    '/mailbox/00000000-0000-4000-8000-000000000001/draft/00000000-0000-4000-8000-000000000002',
    '/mailbox/00000000-0000-4000-8000-000000000001/members',
    '/login',
    '/register',
    '/admin',
    '/admin/audit-events',
    '/admin/users',
    '/admin/connections',
    '/admin/webhook-events',
    '/admin/domains',
    '/admin/roles',
    '/admin/signatures',
    '/admin/settings',
    '/admin/ai',
    '/admin/mcp',
  ])('redirects direct application route %s into setup when incomplete', async (path) => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({ data: { status: 'setup', currentStep: 'claim' } })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({ initialEntries: [path] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/setup/claim');
  });

  it('redirects the real draft recovery route to login without a session', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (input) => {
        const url = String(input);
        return url.endsWith('/api/v1/setup/status')
          ? jsonResponse({ data: { status: 'complete', currentStep: 'complete' } })
          : jsonResponse({ data: { user: null, session: null } });
      }) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const history = createMemoryHistory({
      initialEntries: [
        '/mailbox/00000000-0000-4000-8000-000000000001/draft/00000000-0000-4000-8000-000000000002',
      ],
    });
    const router = createAppRouter(apiClient, queryClient, history);
    await router.load();
    expect(history.location.pathname).toBe('/login');
  });

  it('R-AUTHZ-003 redirects ordinary users away from legacy member management', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (input) =>
        String(input).includes('/auth/me')
          ? jsonResponse({
              data: {
                user: {
                  id: 'user-members-route',
                  email: 'owner@example.test',
                  displayName: 'Owner',
                },
                canAccessAdmin: false,
              },
            })
          : jsonResponse({
              data: { status: 'complete', currentStep: 'complete' },
            })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    queryClient.setQueryData(authQueryKeys.session(), {
      canAccessAdmin: false,
      userId: 'user-members-route',
      email: 'owner@example.test',
      displayName: 'Owner',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const history = createMemoryHistory({
      initialEntries: ['/mailbox/00000000-0000-4000-8000-000000000001/members'],
    });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/mailbox');
  });

  it('matches the real draft recovery route for an authenticated session', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async () =>
        jsonResponse({ data: { status: 'complete', currentStep: 'complete' } })) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    queryClient.setQueryData(authQueryKeys.session(), {
      userId: 'user-a',
      email: 'a@example.test',
      displayName: 'User A',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const history = createMemoryHistory({
      initialEntries: [
        '/mailbox/00000000-0000-4000-8000-000000000001/draft/00000000-0000-4000-8000-000000000002',
      ],
    });
    const router = createAppRouter(apiClient, queryClient, history);
    await router.load();
    expect(history.location.pathname).toBe(
      '/mailbox/00000000-0000-4000-8000-000000000001/draft/00000000-0000-4000-8000-000000000002',
    );
  });
});

// ---------------------------------------------------------------------------
// CAP-044 Slice 2 (AC 13): the /admin section's session guard. Same
// beforeLoad shape as /mailbox — mirrored 1:1 from app/router.tsx so a
// regression in the admin routes' cache-backed guard is caught here.
// Authorization is deliberately NOT part of this tree: the session
// descriptor carries no role signal, so the guard only checks "is there
// a session"; the audit-events PAGE owns the 403 not-authorized surface
// (covered in features/admin/AuditEventsPage.test.tsx).
// ---------------------------------------------------------------------------
describe('router — CAP-067 production role route', () => {
  it.each(['/admin/roles', '/admin/ai', '/admin/mcp'])(
    'matches the real %s route for an authenticated session',
    async (path) => {
      const apiClient = createApiClient({
        baseUrl: '',
        getSessionToken: () => null,
        fetchImpl: (async (input) =>
          String(input).endsWith('/setup/status')
            ? jsonResponse({ data: { status: 'complete', currentStep: 'complete' } })
            : jsonResponse({
                data: {
                  user: {
                    id: 'role-route-admin',
                    email: 'admin@example.test',
                    displayName: 'Role admin',
                  },
                  canAccessAdmin: true,
                  mustChangePassword: false,
                },
              })) as typeof fetch,
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 } },
      });
      queryClient.setQueryData(authQueryKeys.session(), {
        userId: 'role-route-admin',
        email: 'admin@example.test',
        displayName: 'Role admin',
        expiresAt: '2099-01-01T00:00:00Z',
      });
      const history = createMemoryHistory({ initialEntries: [path] });
      const router = createAppRouter(apiClient, queryClient, history);

      await router.load();

      expect(history.location.pathname).toBe(path === '/admin/mcp' ? '/admin/ai' : path);
    },
  );

  it('redirects a member away from the real admin workspace', async () => {
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => 'member-access-token',
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/v1/setup/status')) {
          return jsonResponse({ data: { status: 'complete', currentStep: 'complete' } });
        }
        if (url.includes('/api/v1/auth/me')) {
          return jsonResponse({
            data: {
              user: { id: 'member-id', email: 'member@example.test', displayName: 'Member' },
              mustChangePassword: false,
              canAccessAdmin: false,
            },
          });
        }
        return jsonResponse({ data: { items: [] } });
      }) as typeof fetch,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const history = createMemoryHistory({ initialEntries: ['/admin'] });
    const router = createAppRouter(apiClient, queryClient, history);

    await router.load();

    expect(history.location.pathname).toBe('/mailbox');
  });
});

function buildAdminRouteTree(
  rootRoute: RootRoute<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    undefined,
    RouterContext
  >,
): AnyRoute {
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const adminLandingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin">admin</div>,
  });
  const adminAuditEventsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/audit-events',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-audit-events">audit events</div>,
  });
  // CAP-044 Slice 3 (ACs 19–21): the users / connections / webhook-events
  // routes, mirrored 1:1 from app/router.tsx.
  const adminUsersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/users',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-users">users</div>,
  });
  const adminConnectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/connections',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-connections">connections</div>,
  });
  const adminWebhookEventsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/webhook-events',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-webhook-events">webhook events</div>,
  });
  const adminDomainsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/domains',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-domains">domains</div>,
  });
  const adminRolesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/roles',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-roles">roles</div>,
  });
  const adminSignaturesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/signatures',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-signatures">signatures</div>,
  });
  return rootRoute.addChildren([
    loginRoute,
    adminLandingRoute,
    adminAuditEventsRoute,
    adminUsersRoute,
    adminConnectionsRoute,
    adminWebhookEventsRoute,
    adminDomainsRoute,
    adminRolesRoute,
    adminSignaturesRoute,
  ]);
}

describe('router — /admin guard (CAP-044 Slice 2 / AC 13)', () => {
  it('redirects /admin to /login when there is no session', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ data: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin'],
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('redirects /admin/audit-events to /login when there is no session', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ user: null, session: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/audit-events'],
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('renders /admin/audit-events when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/audit-events'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/audit-events');
    // The warm cache means zero additional fetches for the guard.
    expect(calls.length).toBe(0);
  });

  // CAP-044 Slice 3 (ACs 19–21): each new admin page route carries the
  // same session guard as its siblings.
  it.each([
    '/admin/users',
    '/admin/connections',
    '/admin/webhook-events',
    '/admin/domains',
    '/admin/roles',
    '/admin/signatures',
  ])('redirects %s to /login when there is no session', async (initial) => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ data: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: [initial],
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('renders /admin/users when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/users'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/users');
    expect(calls.length).toBe(0);
  });

  it('renders /admin/domains when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/domains'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/domains');
    expect(calls.length).toBe(0);
  });

  it('renders /admin/roles when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/roles'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/roles');
    expect(calls.length).toBe(0);
  });

  it('renders /admin/signatures when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/signatures'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/signatures');
    expect(calls.length).toBe(0);
  });
});

// CAP-044 Slice 1 (AC 1): the compose route's optional `?replyTo=`
// search param is validated at the route boundary — only a non-empty
// string survives, so the composer never receives a bogus parent id
// (an array from ?replyTo=a&replyTo=b, a number, or an empty string).
describe('validateComposeSearch (CAP-044 Slice 1)', () => {
  it('keeps a non-empty string replyTo and drops every other key', () => {
    expect(validateComposeSearch({ replyTo: 'm-1', other: 'junk' })).toEqual({
      replyTo: 'm-1',
    });
  });

  it('returns an empty object when replyTo is absent', () => {
    expect(validateComposeSearch({})).toEqual({});
  });

  it('drops an empty-string replyTo', () => {
    expect(validateComposeSearch({ replyTo: '' })).toEqual({});
  });

  // Fix pass (g): trim before the emptiness check.
  it('drops a whitespace-only replyTo — the blank composer opens, not a parent 404', () => {
    expect(validateComposeSearch({ replyTo: '   ' })).toEqual({});
    expect(validateComposeSearch({ replyTo: ' \t\n ' })).toEqual({});
  });

  it('keeps a padded replyTo trimmed', () => {
    expect(validateComposeSearch({ replyTo: ' m-1 ' })).toEqual({ replyTo: 'm-1' });
  });

  it('drops non-string replyTo values (number, array, object)', () => {
    expect(validateComposeSearch({ replyTo: 42 })).toEqual({});
    expect(validateComposeSearch({ replyTo: ['m-1', 'm-2'] })).toEqual({});
    expect(validateComposeSearch({ replyTo: { id: 'm-1' } })).toEqual({});
    expect(validateComposeSearch({ replyTo: null })).toEqual({});
    expect(validateComposeSearch({ replyTo: true })).toEqual({});
  });
});

describe('validateFolderSearch (CAP-060)', () => {
  it('keeps each supported folder value', () => {
    expect(validateFolderSearch({ folder: 'inbox' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: 'sent' })).toEqual({ folder: 'sent' });
    expect(validateFolderSearch({ folder: 'drafts' })).toEqual({ folder: 'drafts' });
    expect(validateFolderSearch({ folder: 'archive' })).toEqual({ folder: 'archive' });
    expect(validateFolderSearch({ folder: 'trash' })).toEqual({ folder: 'trash' });
  });

  it('falls back to inbox for missing, empty, repeated, and unsupported values', () => {
    expect(validateFolderSearch({})).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: '' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: ['sent', 'trash'] })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: 'Sent' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: 'outbox' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: null })).toEqual({ folder: 'inbox' });
  });
});
