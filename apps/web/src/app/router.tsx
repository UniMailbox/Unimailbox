import { Spinner } from '../components/ui/Spinner';
import { errorMessage } from '../infrastructure/i18n/error-messages';
import { useT } from '../infrastructure/i18n/locale';
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
// H2 (CAP-041 fix): setup steps are nested below a `/setup` layout route so
// the declared `/setup/<step>` URLs render their child through the layout's
// Outlet. A dynamic parent with static children would create unreachable
// `/setup/$subStep/<step>` paths. The dynamic fallback below retains the
// previous recovery behavior for unknown setup-step URLs.
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
  useNavigate,
  useLocation,
} from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { ErrorComponentProps } from '@tanstack/react-router';
import {
  installationStepSchema,
  messageFolderSchema,
  type InstallationStateInfo,
  type InstallationStep,
  type MessageFolder,
} from '@unimailbox/contracts';
import { lazy, useEffect, type ReactElement } from 'react';
import { ComposeWindowProvider, useComposer } from '../features/mailbox/compose-window-context';
import { ApiError } from '../infrastructure/api/errors';
import type { ApiClient } from '../infrastructure/api/client';
import { fetchSetupStatus, setupQueryKeys } from '../features/setup/setup-queries';
import { SetupLayout } from '../features/setup/setup-layout';
import { authQueryKeys, fetchAuthSession } from '../features/auth/auth-queries';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { ChangePasswordPage } from '../features/auth/ChangePasswordPage';
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

import { AdminLayout } from '../components/layouts/AdminLayout';
import { MailboxLayout } from '../components/layouts/MailboxLayout';

// Keep management and message editors out of the initial authentication bundle.
const DefaultMailboxPage = lazy(() =>
  import('../features/mailbox/DefaultMailboxPage').then((module) => ({
    default: module.DefaultMailboxPage,
  })),
);
const MailboxListPage = lazy(() =>
  import('../features/mailbox/MailboxListPage').then((module) => ({
    default: module.MailboxListPage,
  })),
);
const MailboxWorkspace = lazy(() =>
  import('../features/mailbox/MailboxWorkspace').then((module) => ({
    default: module.MailboxWorkspace,
  })),
);
const MessageDetailPage = lazy(() =>
  import('../features/mailbox/MessageDetailPage').then((module) => ({
    default: module.MessageDetailPage,
  })),
);
const DraftRecoveryPage = lazy(() =>
  import('../features/mailbox/DraftRecoveryPage').then((module) => ({
    default: module.DraftRecoveryPage,
  })),
);

const AdminLandingPage = lazy(() =>
  import('../features/admin/AdminLandingPage').then((module) => ({
    default: module.AdminLandingPage,
  })),
);
const AuditEventsPage = lazy(() =>
  import('../features/admin/AuditEventsPage').then((module) => ({
    default: module.AuditEventsPage,
  })),
);
const UsersPage = lazy(() =>
  import('../features/admin/UsersPage').then((module) => ({ default: module.UsersPage })),
);
const ConnectionsPage = lazy(() =>
  import('../features/admin/ConnectionsPage').then((module) => ({
    default: module.ConnectionsPage,
  })),
);
const WebhookEventsPage = lazy(() =>
  import('../features/admin/WebhookEventsPage').then((module) => ({
    default: module.WebhookEventsPage,
  })),
);
const DomainsPage = lazy(() =>
  import('../features/admin/DomainsPage').then((module) => ({ default: module.DomainsPage })),
);
const RolesPage = lazy(() =>
  import('../features/admin/RolesPage').then((module) => ({ default: module.RolesPage })),
);
const SignaturesPage = lazy(() =>
  import('../features/admin/SignaturesPage').then((module) => ({ default: module.SignaturesPage })),
);
const SettingsPage = lazy(() =>
  import('../features/admin/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);
const AiSettingsPage = lazy(() =>
  import('../features/admin/AiSettingsPage').then((module) => ({ default: module.AiSettingsPage })),
);

// B1 (CAP-041 fix) + CAP-042 Batch 5: typed router context. `beforeLoad`
// reads `context.apiClient` and `context.queryClient` without React hooks.
// Step / page components still use `useApiClient()` and `useQueryClient()`
// (render-time hooks, safe).
export interface RouterContext {
  readonly apiClient: ApiClient;
  readonly queryClient: QueryClient;
}

/**
 * Keep split-origin Vite development aligned with the Worker's installation
 * gate. The Worker redirects incomplete-installation API requests to the SPA
 * setup route, but a browser fetch follows that redirect as JSON and can turn
 * it into a misleading 404. Every application route uses this helper before
 * its session guard so direct links enter the active setup step cleanly.
 */
async function requireCompletedSetup({ apiClient, queryClient }: RouterContext): Promise<void> {
  const setupState = await queryClient.fetchQuery({
    queryKey: setupQueryKeys.status(),
    queryFn: () => fetchSetupStatus(apiClient),
    staleTime: 0,
  });
  if (setupState.status !== 'complete') {
    throw redirect({ to: `/setup/${setupState.currentStep}` as const });
  }
}

async function requireAuthenticatedSession(
  { apiClient, queryClient }: RouterContext,
  options: { readonly allowPasswordChange?: boolean } = {},
): Promise<void> {
  await requireCompletedSetup({ apiClient, queryClient });
  const descriptor = await queryClient.ensureQueryData({
    queryKey: authQueryKeys.session(),
    queryFn: () => fetchAuthSession(apiClient),
  });
  if (descriptor === null) {
    throw redirect({ to: '/login' });
  }
  if (descriptor.mustChangePassword === true && options.allowPasswordChange !== true) {
    throw redirect({ to: '/change-password' });
  }
}

async function requireAdministrativeSession(context: RouterContext): Promise<void> {
  await requireAuthenticatedSession(context);
  // The login/cache descriptor is only a UI hint. Re-read /me when entering
  // the admin workspace so a revoked role cannot leave its navigation shell
  // visible. Individual admin API routes remain the authorization authority.
  const descriptor = await context.queryClient.fetchQuery({
    queryKey: authQueryKeys.session(),
    queryFn: () => fetchAuthSession(context.apiClient),
    staleTime: 0,
  });
  if (descriptor?.canAccessAdmin === false) {
    throw redirect({ to: '/mailbox' });
  }
}

function DefaultPending(): ReactElement {
  const t = useT();
  return (
    <main className="flex min-h-dvh items-center justify-center" aria-busy="true">
      <Spinner label={t('Loading…')} />
    </main>
  );
}

function DefaultError({ error }: ErrorComponentProps): ReactElement {
  const t = useT();
  const message = errorMessage(error instanceof ApiError ? error.code : 'INTERNAL');
  return (
    <main className="unimailbox-stub" role="alert">
      <h1>{t('Something went wrong')}</h1>
      <p>{message}</p>
      <p>
        <a href={window.location.pathname}>{t('Reload')}</a>
      </p>
    </main>
  );
}

function ApplicationOutlet(): ReactElement {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname.startsWith('/mailbox') || pathname.startsWith('/admin') ? (
    <ComposeWindowProvider>
      <Outlet />
    </ComposeWindowProvider>
  ) : (
    <Outlet />
  );
}
const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: ApplicationOutlet,
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
  // The application entrypoint is the mailbox shell. Keeping `/` as a
  // placeholder made a successfully booted frontend look blank/incomplete
  // even though the real feature routes were available. Let the mailbox
  // route own the session guard so unauthenticated users land on `/login`.
  beforeLoad: () => {
    throw redirect({ to: '/mailbox' });
  },
  component: DefaultPending,
});

// /login uses the application-owned email/password session endpoint.
// CAP-042 Batch 8 (M-1 fix): wrap the auth surface in
// <AuthErrorBoundary> so a render-time error inside the form falls
// through to the auth-styled fallback (not the outermost ErrorBoundary
// in App.tsx, which would lose the auth design tokens).
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: async ({ context }) => requireCompletedSetup(context),
  component: () => (
    <AuthErrorBoundary>
      <LoginPage />
    </AuthErrorBoundary>
  ),
});

// /register is a compatibility page explaining admin-managed account
// creation; no invitation or self-service flow is available.
// CAP-042 Batch 8 (M-1 fix): same boundary wrap as /login.
const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  beforeLoad: async ({ context }) => requireCompletedSetup(context),
  component: () => (
    <AuthErrorBoundary>
      <RegisterPage />
    </AuthErrorBoundary>
  ),
});

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/change-password',
  beforeLoad: async ({ context }) =>
    requireAuthenticatedSession(context, { allowPasswordChange: true }),
  component: () => (
    <AuthErrorBoundary>
      <ChangePasswordPage />
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
  beforeLoad: async ({ context }) => requireAuthenticatedSession(context),
  component: () => (
    <MailboxLayout>
      <DefaultMailboxPage />
    </MailboxLayout>
  ),
});

const allMailboxesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailboxes',
  beforeLoad: async ({ context }) => requireAuthenticatedSession(context),
  component: () => (
    <MailboxLayout>
      <MailboxListPage />
    </MailboxLayout>
  ),
});

// CAP-043 Slice 1 (AC 8): the inbox page for a single mailbox.
// Path parameter `mailboxId` is required; `beforeLoad` enforces the
// auth guard (D-CAP-041-1 / D-CAP-041-9) the same way the list
// route does. The component reads `params.mailboxId` directly.
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId',
  validateSearch: validateFolderSearch,
  beforeLoad: async ({ context }) => requireAuthenticatedSession(context),
  component: function InboxListRoute(): ReactElement {
    // The path parameter drives the inbox query key. `useParams` is
    // a TanStack Router hook that resolves to the matched route's
    // declared schema (`$mailboxId` → `mailboxId: string`).
    const params = useParams({ strict: false });
    const search = inboxRoute.useSearch();
    return (
      <MailboxLayout>
        <MailboxWorkspace mailboxId={params.mailboxId} folder={search.folder} />
      </MailboxLayout>
    );
  },
});

// CAP-043 Slice 2 (AC 11): the message-detail page. Same
// D-CAP-041-1 session-cache hydration + D-CAP-041-9 guard as the
// inbox route. The component reads both path parameters directly; the
// mark-read side effect (AC 12) lives in MessageDetailPage, not here.
const messageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId/messages/$messageId',
  beforeLoad: async ({ context }) => requireAuthenticatedSession(context),
  component: function MessageDetailRoute(): ReactElement {
    const params = useParams({ strict: false });
    return (
      <MailboxLayout>
        <MessageDetailPage mailboxId={params.mailboxId} messageId={params.messageId} />
      </MailboxLayout>
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
export function validateComposeSearch(search: Record<string, unknown>): { replyTo?: string } {
  const replyTo = search['replyTo'];
  if (typeof replyTo !== 'string') {
    return {};
  }
  const trimmed = replyTo.trim();
  return trimmed !== '' ? { replyTo: trimmed } : {};
}

/**
 * CAP-060: mailbox folder navigation is a closed search parameter. TanStack
 * Router can receive arrays or other values from repeated/malformed query
 * parameters, so only an exact contract value is allowed to reach the page.
 * Invalid, empty, and missing values deliberately fall back to inbox, the
 * API's default view, rather than creating an unbounded client cache key.
 */
export function validateFolderSearch(search: Record<string, unknown>): { folder: MessageFolder } {
  const parsed = messageFolderSchema.safeParse(search['folder']);
  return { folder: parsed.success ? parsed.data : 'inbox' };
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
  beforeLoad: async ({ context }) => requireAuthenticatedSession(context),
  component: function ComposeRoute(): ReactElement {
    const params = useParams({ strict: false });
    // Route-bound hook: the search type comes from THIS route's
    // validateSearch output, not from a globally registered router.
    const search = composeRoute.useSearch();
    const composer = useComposer();
    const navigate = useNavigate();
    useEffect(() => {
      if (!params.mailboxId) return;
      composer?.open({ mailboxId: params.mailboxId, replyToMessageId: search.replyTo });
      void navigate({
        to: '/mailbox/$mailboxId',
        params: { mailboxId: params.mailboxId },
        search: { folder: 'inbox' },
        replace: true,
      });
    }, [composer?.open, navigate, params.mailboxId, search.replyTo]);
    return <DefaultPending />;
  },
});

// CAP-062 — read-only server draft view with an explicit CAP-061 recovery
// decision. Editing and autosave are intentionally separate capabilities.
const draftRecoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId/draft/$draftId',
  beforeLoad: async ({ context }) => requireAuthenticatedSession(context),
  component: function DraftRecoveryRoute(): ReactElement {
    const params = useParams({ strict: false });
    return (
      <MailboxLayout>
        <DraftRecoveryPage mailboxId={params.mailboxId} draftId={params.draftId} />
      </MailboxLayout>
    );
  },
});

// Preserve old bookmarks while moving permission management into Admin Users.
const mailboxMembersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mailbox/$mailboxId/members',
  beforeLoad: async ({ context }) => {
    await requireAdministrativeSession(context);
    throw redirect({ to: '/admin/users' });
  },
});

// The /admin workspace is hidden when the fresh /me response says the user
// has no administrative capability. Every API route still enforces its own
// permission server-side; this guard only controls the UI shell.
const adminLandingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <AdminLandingPage />
    </AdminLayout>
  ),
});

// CAP-044 Slice 2 (AC 13): the audit-trail viewer. Same session guard;
// requirePermission('audit.read') runs server-side (D-CAP-044-D) and a
// member's 403 renders the page's not-authorized surface (AC 14).
const adminAuditEventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/audit-events',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <AuditEventsPage />
    </AdminLayout>
  ),
});

// CAP-044 Slice 3 (AC 19–21): the users / connections / webhook-events
// pages. Same session guard as the sibling admin routes; each page's
// permission (user.read / webhook_event.read / provider.sync) runs
// server-side and a member's 403 renders that page's not-authorized
// surface.
const adminUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/users',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <UsersPage />
    </AdminLayout>
  ),
});

const adminConnectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/connections',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <ConnectionsPage />
    </AdminLayout>
  ),
});

const adminWebhookEventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/webhook-events',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <WebhookEventsPage />
    </AdminLayout>
  ),
});

const adminDomainsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/domains',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <DomainsPage />
    </AdminLayout>
  ),
});

const adminRolesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/roles',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <RolesPage />
    </AdminLayout>
  ),
});

const adminSignaturesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/signatures',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <SignaturesPage />
    </AdminLayout>
  ),
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/settings',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <SettingsPage />
    </AdminLayout>
  ),
});

const adminAiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/ai',
  beforeLoad: async ({ context }) => requireAdministrativeSession(context),
  component: () => (
    <AdminLayout>
      <AiSettingsPage />
    </AdminLayout>
  ),
});

// Keep old bookmarks working after moving the service card into AI services.
const adminMcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/mcp',
  beforeLoad: async ({ context }) => {
    await requireAdministrativeSession(context);
    throw redirect({ to: '/admin/ai' });
  },
});

// M7 (CAP-041 fix): derive STEP_PATHS from the contracts schema so the
// router and the layout stay in lock-step with the zod enum.
const STEP_PATHS: ReadonlyArray<InstallationStep> =
  installationStepSchema.options as ReadonlyArray<InstallationStep>;

function stepIndex(step: InstallationStep): number {
  return STEP_PATHS.indexOf(step);
}

// H2 (CAP-041 fix): setup steps are children of a `/setup` layout route.
// Keeping the layout parent free of a dynamic segment is important:
// nesting `/claim` below `/setup/$subStep` would produce the unreachable
// path `/setup/$subStep/claim` and leave the layout's Outlet empty.
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupLayout,
});

const setupIndexRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    // CAP-041 follow-up (D-CAP-041-H1): route the setup-status fetch
    // through `context.queryClient.fetchQuery` to mirror
    // `requireCompletedSetup` + `requireSetupStep`. The previous direct
    // `fetchSetupStatus` call bypassed React Query; the layout's
    // `setupStatusQuery()` would then see an empty cache on first paint.
    // Behaviour is benign here (the route is a pure redirect shim; the
    // user always lands on a static step route whose own beforeLoad
    // primes the cache before `<SetupLayout>` mounts), but DRY across
    // the three `fetchSetupStatus` call sites prevents a future
    // maintainer from accidentally splitting the cache hydration shape.
    let state: InstallationStateInfo;
    try {
      state = await context.queryClient.fetchQuery({
        queryKey: setupQueryKeys.status(),
        queryFn: () => fetchSetupStatus(context.apiClient),
        staleTime: 0,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw redirect({ to: '/setup/claim' });
      }
      throw error;
    }
    if (state.status === 'complete') {
      throw redirect({ to: '/' });
    }
    throw redirect({ to: `/setup/${state.currentStep}` as const });
  },
  component: () => null,
});

async function requireSetupStep(
  context: RouterContext,
  expectedStep: InstallationStep,
): Promise<void> {
  // CAP-041 preflight hotfix: route the setup-status fetch through
  // `context.queryClient.fetchQuery` so the cache is populated before
  // `<SetupLayout>` mounts. The previous direct `fetchSetupStatus` call
  // bypassed React Query, so the layout's `setupStatusQuery()` rendered
  // every chip as `upcoming` on first paint — a flash of all-upcoming
  // before the useQuery fetcher landed. Mirrors the same shape
  // `requireCompletedSetup` (a few lines up) uses for the same reason.
  let state: InstallationStateInfo;
  try {
    state = await context.queryClient.fetchQuery({
      queryKey: setupQueryKeys.status(),
      queryFn: () => fetchSetupStatus(context.apiClient),
      staleTime: 0,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw redirect({ to: '/setup/claim' });
    }
    throw error;
  }
  if (state.status === 'complete') {
    throw redirect({ to: '/' });
  }

  const expectedIndex = stepIndex(expectedStep);
  const activeIndex = stepIndex(state.currentStep);
  if (expectedIndex === -1 || expectedIndex > activeIndex) {
    throw redirect({ to: `/setup/${state.currentStep}` as const });
  }
}

const claimRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/claim',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'claim'),
  component: ClaimStep,
});

const preflightRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/preflight',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'preflight'),
  component: PreflightStep,
});

const administratorRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/administrator',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'administrator'),
  component: AdministratorStep,
});

const domainRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/domain',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'domain'),
  component: DomainStep,
});

const cloudflareVerifyRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/cloudflare-verify',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'cloudflare-verify'),
  component: CloudflareVerifyStep,
});

const inboundSmokeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/inbound-smoke',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'inbound-smoke'),
  component: InboundSmokeStep,
});

const brevoRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/brevo',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'brevo'),
  component: BrevoStep,
});

const outboundSmokeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/outbound-smoke',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'outbound-smoke'),
  component: OutboundSmokeStep,
});

const completeRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/complete',
  beforeLoad: async ({ context }) => requireSetupStep(context, 'complete'),
  component: CompleteStep,
});

const unknownSetupStepRoute = createRoute({
  getParentRoute: () => setupRoute,
  path: '/$subStep',
  beforeLoad: async ({ context }) => {
    // CAP-041 follow-up (D-CAP-041-H1): same hydration shape as the
    // sibling routes above — see setupIndexRoute.beforeLoad for the
    // rationale and the maintainer foot-gun DRY closes.
    let state: InstallationStateInfo;
    try {
      state = await context.queryClient.fetchQuery({
        queryKey: setupQueryKeys.status(),
        queryFn: () => fetchSetupStatus(context.apiClient),
        staleTime: 0,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        throw redirect({ to: '/setup/claim' });
      }
      throw error;
    }
    if (state.status === 'complete') {
      throw redirect({ to: '/' });
    }
    throw redirect({ to: `/setup/${state.currentStep}` as const });
  },
  component: () => null,
});

const setupChildren = setupRoute.addChildren([
  setupIndexRoute,
  claimRoute,
  preflightRoute,
  administratorRoute,
  domainRoute,
  cloudflareVerifyRoute,
  inboundSmokeRoute,
  brevoRoute,
  outboundSmokeRoute,
  completeRoute,
  unknownSetupStepRoute,
]);

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  changePasswordRoute,
  mailboxRoute,
  allMailboxesRoute,
  inboxRoute,
  messageDetailRoute,
  composeRoute,
  draftRecoveryRoute,
  mailboxMembersRoute,
  adminLandingRoute,
  adminAuditEventsRoute,
  adminUsersRoute,
  adminConnectionsRoute,
  adminWebhookEventsRoute,
  adminDomainsRoute,
  adminRolesRoute,
  adminSignaturesRoute,
  adminSettingsRoute,
  adminAiRoute,
  adminMcpRoute,
  setupChildren,
]);

export type AppRouter = typeof routeTree;

// B1 (CAP-041 fix) + CAP-042 Batch 5: the router takes the apiClient
// AND the queryClient as constructor arguments and exposes both via
// `context`. `beforeLoad` reads them via `({ context })`; step / page
// components still use `useApiClient()` and `useQueryClient()`.
export function createAppRouter(
  apiClient: ApiClient,
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    defaultPreload: false,
    context: { apiClient, queryClient },
    ...(history === undefined ? {} : { history }),
  });
}
