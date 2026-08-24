// apps/web router — code-based TanStack Router.
// CAP-001 stub extended by CAP-041 with the /setup tree. CAP-042 Batch 5
// adds the /login, /register, and /mailbox subtree; the router validates
// the current setup step against the server's `currentStep` on every
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
//
// CAP-042 Batch 5 / D-CAP-041-1: `queryClient` is added to the router
// context so `mailboxRoute.beforeLoad` can call
// `queryClient.ensureQueryData({ queryKey: authQueryKeys.session(), ... })`.
// The same cache entry feeds `MailboxShell.authSessionQuery`, so the
// `beforeLoad` does the network round-trip once and the component
// reads synchronously.
//
// CAP-042 Batch 5 / D-CAP-041-9: the `/mailbox` route's `beforeLoad`
// redirects to `/login` when the cache contains no session. This is
// exercised by `apps/web/src/app/router.test.tsx` via `mountAppRouter`.
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  redirect,
  useParams,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
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
  authQueryKeys,
  fetchAuthSession,
} from '../features/auth/auth-queries';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { AuthErrorBoundary } from '../features/auth/AuthErrorBoundary';
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
import { MailboxListPage } from '../features/mailbox/MailboxListPage';
import { InboxListPage } from '../features/mailbox/InboxListPage';
import { MessageDetailPage } from '../features/mailbox/MessageDetailPage';
import { ComposeEmail } from '../features/mailbox/ComposeEmail';
import { AdminLandingPage } from '../features/admin/AdminLandingPage';
import { AuditEventsPage } from '../features/admin/AuditEventsPage';
import { UsersPage } from '../features/admin/UsersPage';
import { ConnectionsPage } from '../features/admin/ConnectionsPage';
import { WebhookEventsPage } from '../features/admin/WebhookEventsPage';

// B1 (CAP-041 fix) + CAP-042 Batch 5: typed router context. `beforeLoad`
// reads `context.apiClient` and `context.queryClient` without React hooks.
// Step / page components still use `useApiClient()` and `useQueryClient()`
// (render-time hooks, safe).
export interface RouterContext {
  readonly apiClient: ApiClient;
  readonly queryClient: QueryClient;
}

function DefaultPending(): ReactElement {
  return (
    <main className="unimailbox-stub">
      <p>Loading…</p>
    </main>
  );
}

function DefaultError({ error }: ErrorComponentProps): ReactElement {
  const message = error instanceof Error ? error.message : 'Something went wrong.';
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

// CAP-042 Batch 5 — /login. The login form posts to
// /api/v1/auth/better/sign-in/email; success navigates to /mailbox.
// CAP-042 Batch 8 (M-1 fix): wrap the auth surface in
// <AuthErrorBoundary> so a render-time error inside the form falls
// through to the auth-styled fallback (not the outermost ErrorBoundary
// in App.tsx, which would lose the auth design tokens).
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: () => (
    <AuthErrorBoundary>
      <LoginPage />
    </AuthErrorBoundary>
  ),
});

// CAP-042 Batch 5 — /register. Self-service registration is the legacy
// /api/v1/auth/register endpoint; success navigates to /login so the
// user can sign in with the new credentials (registration is separate
// from sign-in, per CAP-019 / R-AUTH-006).
// CAP-042 Batch 8 (M-1 fix): same boundary wrap as /login.
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: () => (
    <AuthErrorBoundary>
      <RegisterPage />
    </AuthErrorBoundary>
  ),
});

// CAP-042 Batch 5 — /mailbox.
//
// D-CAP-041-1: the `beforeLoad` warms the session cache via
// `queryClient.ensureQueryData`. A cache hit means zero additional
// network requests on subsequent navigations to /mailbox; a cache
// miss triggers exactly one GET /api/v1/auth/better/get-session,
// shared with MailboxShell's `authSessionQuery`.
//
// D-CAP-041-9: the redirect-to-`/login` branch is exercised by
// `apps/web/src/app/router.test.tsx`. A reviewer should be able to
// read the test and see the route tree mount with an empty session
// store, navigate to `/mailbox`, and assert the final pathname is
// `/login`.
//
// CAP-043 Slice 1 (AC 7): the placeholder MailboxShell is replaced
// by the real MailboxListPage. The authorized-shell still exists as
// an alternate entrypoint (kept for the Batch 5 sign-in test).
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
  component: () => <MailboxListPage />,
});

// CAP-043 Slice 1 (AC 8): the inbox page for a single mailbox.
// Path parameter `mailboxId` is required; `beforeLoad` enforces the
// auth guard (D-CAP-041-1 / D-CAP-041-9) the same way the list
// route does. The component reads `params.mailboxId` directly.
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId',
  beforeLoad: async ({ context }) => {
    const descriptor = await context.queryClient.ensureQueryData({
      queryKey: authQueryKeys.session(),
      queryFn: () => fetchAuthSession(context.apiClient),
    });
    if (descriptor === null) {
      throw redirect({ to: '/login' });
    }
  },
  component: function InboxListRoute(): ReactElement {
    // The path parameter drives the inbox query key. `useParams` is
    // a TanStack Router hook that resolves to the matched route's
    // declared schema (`$mailboxId` → `mailboxId: string`).
    const params = useParams({ strict: false });
    return <InboxListPage mailboxId={params.mailboxId} />;
  },
});

// CAP-043 Slice 2 (AC 11): the message-detail page. Same
// D-CAP-041-1 session-cache hydration + D-CAP-041-9 guard as the
// inbox route. The component reads both path parameters directly; the
// mark-read side effect (AC 12) lives in MessageDetailPage, not here.
const messageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId/messages/$messageId',
  beforeLoad: async ({ context }) => {
    const descriptor = await context.queryClient.ensureQueryData({
      queryKey: authQueryKeys.session(),
      queryFn: () => fetchAuthSession(context.apiClient),
    });
    if (descriptor === null) {
      throw redirect({ to: '/login' });
    }
  },
  component: function MessageDetailRoute(): ReactElement {
    const params = useParams({ strict: false });
    return (
      <MessageDetailPage
        mailboxId={params.mailboxId}
        messageId={params.messageId}
      />
    );
  },
});

// CAP-044 Slice 1 (AC 1 + AC 5): the compose route's optional
// `replyTo` search param, VALIDATED at the route boundary. Only a
// non-empty string survives; arrays, numbers, and empty strings are
// dropped so the composer never receives a bogus parent id. Fix pass
// (g): the emptiness check runs on the TRIMMED value — whitespace-only
// `replyTo` drops the param (blank composer) instead of a guaranteed
// parent 404, and a padded id survives trimmed. Exported for unit
// tests (router.test.tsx) — the route is the only consumer.
export function validateComposeSearch(
  search: Record<string, unknown>,
): { replyTo?: string } {
  const replyTo = search['replyTo'];
  if (typeof replyTo !== 'string') {
    return {};
  }
  const trimmed = replyTo.trim();
  return trimmed !== '' ? { replyTo: trimmed } : {};
}

// CAP-044 Slice 1 (AC 1 + AC 5): the composer at
// /mailbox/$mailboxId/compose, with an optional ?replyTo=<messageId>
// (validated above — a reply pre-fills the form from the parent's
// detail, D-CAP-044-C). Same D-CAP-041-1 session-cache hydration +
// D-CAP-041-9 guard as the sibling mailbox routes. A Link without a
// `search` prop navigates with an EMPTY search (TanStack default), so
// the inbox's Compose action opens a blank composer even from a URL
// that carries a replyTo.
const composeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId/compose',
  validateSearch: validateComposeSearch,
  beforeLoad: async ({ context }) => {
    const descriptor = await context.queryClient.ensureQueryData({
      queryKey: authQueryKeys.session(),
      queryFn: () => fetchAuthSession(context.apiClient),
    });
    if (descriptor === null) {
      throw redirect({ to: '/login' });
    }
  },
  component: function ComposeRoute(): ReactElement {
    const params = useParams({ strict: false });
    // Route-bound hook: the search type comes from THIS route's
    // validateSearch output, not from a globally registered router.
    const search = composeRoute.useSearch();
    return (
      <ComposeEmail mailboxId={params.mailboxId} replyToMessageId={search.replyTo} />
    );
  },
});

// CAP-044 Slice 2 (AC 13; CAP-033 absorbed, D-CAP-044-E): the /admin
// section. Session-guarded exactly like /mailbox (D-CAP-041-1 cache
// hydration + D-CAP-041-9 redirect). Authorization is NOT decided here —
// the session descriptor carries no role/permission signal (see
// features/admin/admin-queries.ts), so each admin page enforces its
// permission server-side and renders the not-authorized state for
// members. The nav-signal gap is reported to the orchestrator; widening
// the session endpoint is not this slice's call.
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
  component: AdminLandingPage,
});

// CAP-044 Slice 2 (AC 13): the audit-trail viewer. Same session guard;
// requirePermission('audit.read') runs server-side (D-CAP-044-D) and a
// member's 403 renders the page's not-authorized surface (AC 14).
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
  component: AuditEventsPage,
});

// CAP-044 Slice 3 (AC 19–21): the users / connections / webhook-events
// pages. Same session guard as the sibling admin routes; each page's
// permission (user.read / webhook_event.read / provider.sync) runs
// server-side and a member's 403 renders that page's not-authorized
// surface.
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
  component: UsersPage,
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
  component: ConnectionsPage,
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
  component: WebhookEventsPage,
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  mailboxRoute,
  inboxRoute,
  messageDetailRoute,
  composeRoute,
  adminLandingRoute,
  adminAuditEventsRoute,
  adminUsersRoute,
  adminConnectionsRoute,
  adminWebhookEventsRoute,
  setupIndexRoute,
  setupChildren,
]);

export type AppRouter = typeof routeTree;

// B1 (CAP-041 fix) + CAP-042 Batch 5: the router takes the apiClient
// AND the queryClient as constructor arguments and exposes both via
// `context`. `beforeLoad` reads them via `({ context })`; step / page
// components still use `useApiClient()` and `useQueryClient()`.
export function createAppRouter(apiClient: ApiClient, queryClient: QueryClient) {
  return createRouter({
    routeTree,
    defaultPreload: false,
    context: { apiClient, queryClient },
  });
}