// apps/web — MailboxListPage tests.
//
// CAP-043 Slice 1 (AC 7). The authorized mailbox-list page surfaces
// every state the user can land in:
//
//   - One mailbox — renders a list row whose click navigates to the
//     inbox route.
//   - Empty list — renders the "No mailboxes yet" line.
//   - Error — renders <MailboxError /> with retry (non-401; the
//     401 → /login path is owned by the router's `beforeLoad`).
//   - Unauthorized (descriptor null) — surfaces
//     <Unauthorized variant="expired" /> (D-CAP-041-9 fallback, fix pass
//     F5) when the session expires between the router guard and the
//     component render; asserts the expired-session surface renders and
//     no mailbox rows (or the empty state) do.
//
// The router is mounted via the shared `mountAppRouter` helper, so
// navigation goes through real TanStack Router state. The `lastPathname`
// helper is the canonical way to assert the final URL.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoute, Outlet, type RootRoute } from '@tanstack/react-router';
import { MailboxListPage } from './MailboxListPage';
import {
  errorResponse,
  jsonResponse,
  lastPathname,
  mountAppRouter,
  spyFetch,
} from '../../test-utils';
import {
  resetAuthSessionForTesting,
  setAuthSession,
  type AuthSessionDescriptor,
} from '../auth/auth-session-store';
import type { RouterContext } from '../../app/router';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

const SESSION: AuthSessionDescriptor = {
  userId: 'u-1',
  email: 'a@b.test',
  displayName: 'A B',
  expiresAt: '2099-01-01T00:00:00Z',
};

/**
 * The Better Auth–shaped session response `withAdminProbeDenied`
 * dispatches for every get-session refetch (the session query has
 * `staleTime: 0`, so each new observer — including the AppNav probe's —
 * refetches on mount; the dispatch keeps those refetches from consuming
 * a sequential resolver slot meant for the mailbox-list endpoint).
 */
function authSessionResolver(): Response {
  return jsonResponse({
    data: {
      user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
      session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
    },
  });
}

/**
 * Build a tiny route tree that mounts the inbox route at `/mailbox`
 * so the test can simulate clicking a mailbox row and observe the
 * resulting pathname.
 */
type TestRootRoute = RootRoute<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  undefined,
  RouterContext
>;

/**
 * CAP-044 Slice 3: MailboxListPage now mounts <AppNav />, whose probe
 * fires `GET /api/v1/admin/audit-events?limit=1` once per session, and
 * whose embedded session observer subscribes after the header renders —
 * an extra get-session refetch under `staleTime: 0`. Dispatch BOTH URLs
 * around the sequential spy: get-session always answers with the SESSION
 * descriptor (the member-shaped case — every wrapper-using test signs a
 * member in), and the probe answers with a member's 403 (no Admin link).
 * Everything else falls through to the sequential resolvers, so the
 * resolver lists serve only the mailbox-list endpoint. Same convention
 * as AuditEventsPage.test.tsx.
 */
function withAdminProbeDenied(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      return authSessionResolver();
    }
    if (url.startsWith('/api/v1/admin/audit-events')) {
      return errorResponse('PERMISSION_DENIED', 'Forbidden', 403);
    }
    return inner(input, init);
  };
}

function buildMailboxRoutes(rootRoute: TestRootRoute) {
  const mailboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox',
    component: () => <Outlet />,
  });
  const inboxRoute = createRoute({
    getParentRoute: () => mailboxRoute,
    path: '$mailboxId',
    component: () => <div data-testid="arrived-inbox">inbox</div>,
  });
  const listRoute = createRoute({
    getParentRoute: () => mailboxRoute,
    path: '/',
    component: () => <MailboxListPage />,
  });
  return rootRoute.addChildren([
    mailboxRoute.addChildren([listRoute, inboxRoute]),
  ]);
}

describe('MailboxListPage', () => {
  it('renders one mailbox row whose click navigates to /mailbox/$mailboxId', async () => {
    const { fetchImpl } = spyFetch([
      () =>
        jsonResponse({
          data: {
            items: [
              {
                id: 'mb-1',
                address: 'inbox@example.com',
                displayName: 'Inbox',
                status: 'active',
                domainId: 'dom-1',
                localPart: 'inbox',
                ownerUserId: 'u-1',
              },
            ],
          },
        }),
    ]);
    setAuthSession(SESSION);
    const user = userEvent.setup();
    const { history } = await mountAppRouter({
      fetchImpl: withAdminProbeDenied(fetchImpl),
      authSession: SESSION,
      initialEntries: ['/mailbox'],
      buildRouteTree: buildMailboxRoutes,
    });

    await waitFor(() => {
      expect(screen.getByTestId('mailbox-list')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mailbox-list-row')).toBeInTheDocument();
    // CAP-044 Slice 3 (D-CAP-044-K): a member's probe 403 renders NO
    // admin link in the header.
    expect(screen.queryByTestId('app-nav')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('mailbox-list-row-button'));
    expect(lastPathname(history)).toBe('/mailbox/mb-1');
  });

  it('renders the empty state when the user has no mailboxes', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: { items: [] } }),
    ]);
    setAuthSession(SESSION);
    await mountAppRouter({
      fetchImpl: withAdminProbeDenied(fetchImpl),
      authSession: SESSION,
      initialEntries: ['/mailbox'],
      buildRouteTree: buildMailboxRoutes,
    });
    await waitFor(() => {
      expect(screen.getByTestId('mailbox-list-empty')).toBeInTheDocument();
    });
  });

  it('renders the error state with retry when the list fetch fails', async () => {
    // 502 is non-retryable by the API client (only 5xx and 429 retry; the
    // retry policy's `defaultRetryPolicy.nextDelay` returns null when
    // attempt > 5, but at 502 it's still retryable — to keep this test
    // fast and deterministic we use 400 instead). R-API-002: the error
    // envelope's `code` is what the panel surfaces under the message.
    const { fetchImpl } = spyFetch([
      () => errorResponse('INTERNAL', 'fail', 400),
      () => jsonResponse({ data: { items: [] } }),
    ]);
    setAuthSession(SESSION);
    const user = userEvent.setup();
    await mountAppRouter({
      fetchImpl: withAdminProbeDenied(fetchImpl),
      authSession: SESSION,
      initialEntries: ['/mailbox'],
      buildRouteTree: buildMailboxRoutes,
    });
    await waitFor(() => {
      expect(screen.getByTestId('mailbox-error')).toBeInTheDocument();
    });
    // Click the inner "Retry" button (not the panel wrapper, which has
    // no click handler).
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    // After retry, the empty list path renders.
    await waitFor(() => {
      expect(screen.getByTestId('mailbox-list-empty')).toBeInTheDocument();
    });
  });

  it('renders the expired-session fallback when the descriptor resolves to null (D-CAP-041-9)', async () => {
    // Fix pass F5: mounting with authSession=null pre-seeds the session
    // cache with the exact state a mid-flight session revocation leaves
    // behind *after* the router guard already passed. The page must
    // render the actionable expired-session surface — not the "No
    // mailboxes yet" empty state — and no mailbox rows may render.
    const { fetchImpl } = spyFetch([]);
    await mountAppRouter({
      fetchImpl,
      authSession: null,
      initialEntries: ['/mailbox'],
      buildRouteTree: (rootRoute) => {
        const listRoute = createRoute({
          getParentRoute: () => rootRoute,
          path: '/mailbox',
          component: () => <MailboxListPage />,
        });
        return rootRoute.addChildren([listRoute]);
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    });
    // The Sign-in CTA is the recovery path.
    expect(screen.getByTestId('unauthorized-login-button')).toBeInTheDocument();
    // No list surface renders alongside the fallback.
    expect(screen.queryByTestId('mailbox-list-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mailbox-list-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mailbox-list')).not.toBeInTheDocument();
  });
});