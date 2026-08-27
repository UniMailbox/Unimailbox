// apps/web — test helpers for step components.
//
// CAP-041: tests mount step components inside a real TanStack Router
// memory-history tree so `useNavigate()` resolves to a real navigate
// function. This is a browser-context test (happy-dom + RTL), not
// Playwright. The router state is observable via `lastPathname()`,
// which lets us assert navigation without introspecting router internals.
//
// H6 (CAP-041 fix): the apiClient's session-token getter now reads
// `useSetupSession.getState().sessionToken` at call-time. Previously
// the test harness used a frozen snapshot, so resetSetupSessionForTesting
// did not propagate. `mountAppRouter()` lets future tests that exercise
// the router's `beforeLoad` (which needs an apiClient in its context)
// build the same shape as `renderStep()`.
//
// CAP-042 Batch 5: `mountAppRouter()` threads the queryClient into the
// router's context (D-CAP-041-1) and accepts an optional auth-session
// fixture so router tests can pre-seed `authQueryKeys.session()` in the
// cache or in the in-memory descriptor store.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen } from '@testing-library/react';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { AnyRoute, AnyRouter, RootRoute } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { ApiClientProvider } from './infrastructure/api/client-provider';
import { createApiClient, type ApiClient } from './infrastructure/api/client';
import {
  resetSetupSessionForTesting,
  setSetupSession,
  useSetupSession,
} from './features/setup/setup-session-store';
import {
  resetAuthSessionForTesting,
  setAuthSession,
  type AuthSessionDescriptor,
} from './features/auth/auth-session-store';
import { authQueryKeys } from './features/auth/auth-queries';
import type { RouterContext } from './app/router';

export interface RenderStepOptions {
  readonly fetchImpl: typeof fetch;
  readonly sessionToken?: string;
  readonly step: ReactElement;
}

// `RouterProvider` mounts the route tree; tests must `await router.load()`
// before rendering, otherwise the active route never resolves and the
// body stays empty. Each call creates a fresh router — there is no
// cross-test bleed because tests reset via afterEach(cleanup).
//
// The step element is rendered by `targetRoute.component` directly, NOT
// as a child of RouterProvider (this TanStack Router version does not
// accept children on RouterProvider — the route tree is the only mount).
async function mountRouter(options: RenderStepOptions): Promise<AnyRouter> {
  resetSetupSessionForTesting();
  const rootRoute = createRootRoute({
    component: () => <Outlet />,
  });
  const targetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/start',
    component: () => options.step,
  });
  const preflightRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/preflight',
    component: () => <div data-testid="arrived-preflight">preflight</div>,
  });
  const administratorRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/administrator',
    component: () => <div data-testid="arrived-administrator">administrator</div>,
  });
  const domainRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/domain',
    component: () => <div data-testid="arrived-domain">domain</div>,
  });
  const cloudflareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/cloudflare-verify',
    component: () => <div data-testid="arrived-cloudflare-verify">cloudflare-verify</div>,
  });
  const inboundSmokeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/inbound-smoke',
    component: () => <div data-testid="arrived-inbound-smoke">inbound-smoke</div>,
  });
  const brevoRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/brevo',
    component: () => <div data-testid="arrived-brevo">brevo</div>,
  });
  const outboundSmokeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/outbound-smoke',
    component: () => <div data-testid="arrived-outbound-smoke">outbound-smoke</div>,
  });
  const completeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/setup/complete',
    component: () => <div data-testid="arrived-complete">complete</div>,
  });
  const routeTree = rootRoute.addChildren([
    targetRoute,
    preflightRoute,
    administratorRoute,
    domainRoute,
    cloudflareRoute,
    inboundSmokeRoute,
    brevoRoute,
    outboundSmokeRoute,
    completeRoute,
  ]);
  const history = createMemoryHistory({ initialEntries: ['/setup/start'] });
  // Cast: createRouter's return is generic over the route tree's Register;
  // we want AnyRouter for storage/return. The runtime router matches.
  const router = createRouter({ routeTree, history }) as unknown as AnyRouter;
  await router.load();
  return router;
}

export async function renderStep(options: RenderStepOptions): Promise<{
  rerender: ReturnType<typeof rtlRender>['rerender'];
  unmount: ReturnType<typeof rtlRender>['unmount'];
  container: HTMLElement;
  history: ReturnType<typeof createMemoryHistory>;
}> {
  resetSetupSessionForTesting();
  if (options.sessionToken !== undefined) {
    setSetupSession(options.sessionToken);
  }
  const router = await mountRouter(options);
  const history = router.history as ReturnType<typeof createMemoryHistory>;
  // H6 (CAP-041 fix): the getter reads from the live Zustand store so
  // `resetSetupSessionForTesting` + `setSetupSession` propagate to the
  // client during the test (no closure-time snapshot).
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => useSetupSession.getState().sessionToken,
    fetchImpl: options.fetchImpl,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children: _children }: { children: ReactNode }): ReactElement {
    // RouterProvider reads its route tree; children would shadow the
    // active route. The step is rendered by targetRoute.component.
    return (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>
    );
  }
  const result = rtlRender(<div data-testid="root" />, { wrapper: Wrapper });
  return {
    rerender: result.rerender,
    unmount: result.unmount,
    container: result.container,
    history,
  };
}

// H6 (CAP-041 fix) + CAP-042 Batch 5: mountAppRouter — for tests that
// exercise the router's `beforeLoad` (which reads `apiClient` and the
// `queryClient` via `context`). `renderStep()` is fine for step-component
// tests; router tests need both providers injected into the router's
// context so `beforeLoad` can call them without a React hook. The route
// tree is built lazily inside the test via `buildRouteTree(rootRoute)`
// so the routeTree's type inference stays intact.
//
// `authSession` pre-seeds the TanStack Query cache and the in-memory
// descriptor store so tests that exercise the `/mailbox` route after a
// successful sign-in can skip the login step. Omit it (or pass `null`)
// to assert the `/mailbox` → `/login` redirect (D-CAP-041-9).
export interface MountAppRouterOptions {
  readonly fetchImpl: typeof fetch;
  readonly buildRouteTree: (
    rootRoute: RootRoute<
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any,
      undefined,
      RouterContext
    >,
  ) => AnyRoute | undefined;
  readonly initialEntries?: ReadonlyArray<string>;
  readonly sessionToken?: string;
  readonly apiClient?: ApiClient;
  readonly authSession?: AuthSessionDescriptor | null;
}

export async function mountAppRouter(options: MountAppRouterOptions): Promise<{
  readonly router: AnyRouter;
  readonly history: ReturnType<typeof createMemoryHistory>;
  readonly apiClient: ApiClient;
  readonly queryClient: QueryClient;
  render: () => ReturnType<typeof rtlRender>;
  rerender: ReturnType<typeof rtlRender>['rerender'];
  unmount: ReturnType<typeof rtlRender>['unmount'];
  container: HTMLElement;
}> {
  resetSetupSessionForTesting();
  resetAuthSessionForTesting();
  if (options.sessionToken !== undefined) {
    setSetupSession(options.sessionToken);
  }
  // CAP-042 Batch 5: create the QueryClient BEFORE the router so we can
  // thread it into the router's `context` (D-CAP-041-1). Pre-seed the
  // `authQueryKeys.session()` cache entry from the `authSession`
  // fixture, then mirror the descriptor into the in-memory store.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  if (options.authSession !== undefined) {
    if (options.authSession !== null) {
      queryClient.setQueryData(authQueryKeys.session(), options.authSession);
      setAuthSession(options.authSession);
    } else {
      queryClient.setQueryData(authQueryKeys.session(), null);
    }
  }
  const apiClient =
    options.apiClient ??
    createApiClient({
      baseUrl: '',
      getSessionToken: () => useSetupSession.getState().sessionToken,
      fetchImpl: options.fetchImpl,
    });
  const history = createMemoryHistory({
    initialEntries: [...(options.initialEntries ?? ['/'])],
  });
  const rootRoute = createRootRouteWithContextHelper();
  // The routeTree is built by the caller; we accept the typed result
  // and pass it through. The router is cast to AnyRouter so callers
  // don't need to thread the inferred generics through.
  const routeTree = options.buildRouteTree(rootRoute);
  const router = createRouter({
    routeTree: routeTree as AnyRoute,
    history,
    context: { apiClient, queryClient },
    defaultPreload: false,
  }) as unknown as AnyRouter;
  await router.load();
  function Wrapper({ children: _children }: { children: ReactNode }): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>
    );
  }
  const render = (): ReturnType<typeof rtlRender> =>
    rtlRender(<div data-testid="root" />, { wrapper: Wrapper });
  // Auto-render so callers can read the DOM immediately after
  // `await mountAppRouter(...)`. `router.test.tsx` and other history-only
  // tests ignore the rendered tree — the router's `await load()` above
  // already resolved the active route.
  const rendered = render();
  return {
    router,
    history,
    apiClient,
    queryClient,
    render,
    rerender: rendered.rerender,
    unmount: rendered.unmount,
    container: rendered.container,
  };
}

export function lastPathname(history: ReturnType<typeof createMemoryHistory>): string {
  return history.location.pathname;
}

// CAP-042 Batch 5: renderAuthPage — for tests that mount an auth page
// (LoginPage / RegisterPage / LogoutButton / Unauthorized) inside a
// real router. Mirrors `renderStep()` but for the auth surface: a
// minimal route tree with /login, /register, /mailbox, and a sentinel
// landing page so `useNavigate({ to: '/mailbox' })` and friends resolve
// to a real destination the test can observe via `lastPathname()`.
export interface RenderAuthPageOptions {
  readonly fetchImpl: typeof fetch;
  readonly authSession?: AuthSessionDescriptor | null;
  readonly initialPath?: string;
  readonly login?: ReactElement;
  readonly register?: ReactElement;
  readonly mailbox?: ReactElement;
}

export async function renderAuthPage(options: RenderAuthPageOptions): Promise<{
  readonly router: AnyRouter;
  readonly history: ReturnType<typeof createMemoryHistory>;
  readonly apiClient: ApiClient;
  readonly queryClient: QueryClient;
  render: () => ReturnType<typeof rtlRender>;
  rerender: ReturnType<typeof rtlRender>['rerender'];
  unmount: ReturnType<typeof rtlRender>['unmount'];
  container: HTMLElement;
}> {
  return mountAppRouter({
    fetchImpl: options.fetchImpl,
    initialEntries: [options.initialPath ?? '/login'],
    ...(options.authSession !== undefined ? { authSession: options.authSession } : {}),
    buildRouteTree: (rootRoute) => {
      const loginRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/login',
        component: () => options.login ?? <div data-testid="arrived-login">login</div>,
      });
      const registerRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/register',
        component: () => options.register ?? <div data-testid="arrived-register">register</div>,
      });
      const mailboxRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/mailbox',
        component: () => options.mailbox ?? <div data-testid="arrived-mailbox">mailbox</div>,
      });
      return rootRoute.addChildren([loginRoute, registerRoute, mailboxRoute]);
    },
  });
}

// H6 (CAP-041 fix): typed root-route helper. Local re-export so
// `mountAppRouter` callers can build a context-aware root route
// without importing TanStack Router's `createRootRouteWithContext`
// directly.
function createRootRouteWithContextHelper(): RootRoute<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  undefined,
  RouterContext
> {
  return createRootRouteWithContext<RouterContext>()({
    component: () => <Outlet />,
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId: 'req-test' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface SpyFetch {
  readonly fetchImpl: typeof fetch;
  readonly calls: Array<{ url: string; method: string }>;
}

export function spyFetch(
  resolvers: Array<(call: { url: string; method: string }) => Response>,
): SpyFetch {
  const calls: Array<{ url: string; method: string }> = [];
  let index = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const call = { url, method };
    calls.push(call);
    const resolver = resolvers[Math.min(index, resolvers.length - 1)];
    if (resolver === undefined) {
      return new Response('', { status: 599 });
    }
    const isLast = index >= resolvers.length - 1;
    if (!isLast) index += 1;
    return resolver(call);
  };
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
  };
}

export { screen };
