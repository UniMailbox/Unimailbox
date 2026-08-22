// apps/web router — code-based TanStack Router.
// CAP-001 stub extended by CAP-041 with the /setup tree. The router
// validates the current step against the server's `currentStep` on every
// mount (R-WORKFLOW-001 / D4) and redirects stale /setup/<step> URLs
// back to the server's current step.
//
// B1 (CAP-041 fix): the router's `beforeLoad` no longer calls
// `useApiClient()`. The hook invoked `useContext` outside any React
// render, throwing on every navigation into /setup. The apiClient is
// now passed via the router's `context` (created in `createAppRouter`)
// and read via `({ context })` — a plain argument, not a hook.
//
// H1 (CAP-041 fix): the `beforeLoad` calls `setupStatusQuery`'s fetcher
// (already extracted in `setup-queries.ts`) instead of hand-rolling the
// status fetch. Same behaviour, one source of truth.
//
// H2 (CAP-041 fix): sub-route path parsing is replaced by a typed
// `$subStep` path parameter on `setupRoute`. The layout component reads
// `params.subStep` directly.
//
// H3 (CAP-041 fix): the dead `useState`/`useEffect` force-update
// subscription to the query cache is removed. The TanStack `useQuery`
// hook already re-renders the layout when the status query mutates.
//
// M7 (CAP-041 fix): STEP_PATHS is derived from
// `installationStepSchema.options` so the router order matches the
// contracts schema exactly.
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  redirect,
} from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import {
  installationStepSchema,
  type InstallationStateInfo,
  type InstallationStep,
} from '@unimailbox/contracts';
import type { ReactElement } from 'react';
import { ApiError } from '../infrastructure/api/errors';
import type { ApiClient } from '../infrastructure/api/client';
import { fetchSetupStatus } from '../features/setup/setup-queries';
import { SetupLayout } from '../features/setup/setup-layout';
import {
  ClaimStep,
  PreflightStep,
  AdministratorStep,
  DomainStep,
  CloudflareVerifyStep,
  InboundSmokeStep,
  BrevoStep,
  OutboundSmokeStep,
  CompleteStep,
} from '../features/setup';

// B1 (CAP-041 fix): typed router context. `beforeLoad` reads
// `context.apiClient` without a React hook. Step components still
// use `useApiClient()` (render-time hook, safe).
export interface RouterContext {
  readonly apiClient: ApiClient;
}

function DefaultPending(): ReactElement {
  return (
    <main className="unimailbox-stub">
      <p>Loading…</p>
    </main>
  );
}

function DefaultError({ error }: ErrorComponentProps): ReactElement {
  const message =
    error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <main className="unimailbox-stub" role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </main>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <main className="unimailbox-stub">
      <h1>404</h1>
      <p>Page not found.</p>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </main>
  ),
  pendingComponent: DefaultPending,
  errorComponent: DefaultError,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
    <main className="unimailbox-stub">
      <h1>Unimailbox</h1>
      <p>The client is wired. Feature pages land with later capabilities.</p>
    </main>
  ),
});

// M7 (CAP-041 fix): derive STEP_PATHS from the contracts schema so the
// router and the layout stay in lock-step with the zod enum.
const STEP_PATHS: ReadonlyArray<InstallationStep> =
  installationStepSchema.options as ReadonlyArray<InstallationStep>;

function stepIndex(step: InstallationStep): number {
  return STEP_PATHS.indexOf(step);
}

// H2 (CAP-041 fix): the setup route uses a typed `$subStep` path
// parameter. `setupIndexRoute` (path `/`) handles the bare `/setup`
// case; the rest are `/setup/<subStep>`. The `beforeLoad` no longer
// hand-parses `location.pathname`.
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup/$subStep',
  parseParams: (raw) => ({
    subStep: raw.subStep === '' ? undefined : raw.subStep,
  }),
  stringifyParams: ({ subStep }) => ({ subStep: subStep ?? '' }),
  // B1 / H1 (CAP-041 fix): beforeLoad receives the router context
  // (apiClient) as a plain argument. No hooks, safe outside React.
  beforeLoad: async ({ context, params }) => {
    const apiClient = context.apiClient;
    let state: InstallationStateInfo;
    try {
      state = await fetchSetupStatus(apiClient);
    } catch (error) {
      if (error instanceof ApiError) {
        throw redirect({ to: '/setup/claim' });
      }
      throw error;
    }
    const activeStep: InstallationStep = state.currentStep;
    if (state.status === 'complete') {
      throw redirect({ to: '/' });
    }
    const subStep = params.subStep;
    if (subStep === undefined) {
      throw redirect({ to: `/setup/${activeStep}` as const });
    }
    if (subStep === activeStep) {
      return;
    }
    const subIndex = STEP_PATHS.indexOf(subStep as InstallationStep);
    const activeIndex = stepIndex(activeStep);
    if (subIndex === -1) {
      // Unknown sub-step (stale bookmark, typo, or operator URL tinkering).
      // Fall back to the server's current step rather than rendering an
      // empty <Outlet/>. Same path the stale-ahead branch takes.
      throw redirect({ to: `/setup/${activeStep}` as const });
    }
    if (subIndex > activeIndex) {
      throw redirect({ to: `/setup/${activeStep}` as const });
    }
  },
  component: function SetupLayoutRoute(): ReactElement {
    return <SetupLayout />;
  },
});

const setupIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: () => {
    throw redirect({ to: '/setup/claim' });
  },
  component: () => <Outlet />,
});

const claimRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/claim',
  component: ClaimStep,
});

const preflightRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/preflight',
  component: PreflightStep,
});

const administratorRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/administrator',
  component: AdministratorStep,
});

const domainRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/domain',
  component: DomainStep,
});

const cloudflareVerifyRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/cloudflare-verify',
  component: CloudflareVerifyStep,
});

const inboundSmokeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/inbound-smoke',
  component: InboundSmokeStep,
});

const brevoRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/brevo',
  component: BrevoStep,
});

const outboundSmokeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/outbound-smoke',
  component: OutboundSmokeStep,
});

const completeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/complete',
  component: CompleteStep,
});

const setupChildren = setupRoute.addChildren([
  claimRoute,
  preflightRoute,
  administratorRoute,
  domainRoute,
  cloudflareVerifyRoute,
  inboundSmokeRoute,
  brevoRoute,
  outboundSmokeRoute,
  completeRoute,
]);

const routeTree = rootRoute.addChildren([indexRoute, setupIndexRoute, setupChildren]);

export type AppRouter = typeof routeTree;

// B1 (CAP-041 fix): the router takes the apiClient as a constructor
// argument and exposes it via `context`. beforeLoad reads it via
// `({ context })`; step components still use `useApiClient()`.
export function createAppRouter(apiClient: ApiClient) {
  return createRouter({
    routeTree,
    defaultPreload: false,
    context: { apiClient },
  });
}