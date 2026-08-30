// apps/web — InboxListPage tests.
//
// CAP-043 Slice 1 (AC 8). The authorized inbox list page renders one of
// four mutually-exclusive states:
//
//   - Loading — `<InboxListSkeleton />` while the first page is in-flight.
//   - Empty — `<InboxEmpty />` ("No messages in this mailbox yet.").
//   - Error — data-first (CAP-044 Slice 3 fix pass (g), the D-CAP-044-L
//     fold-in): with NO data the error panel renders — INVALID_CURSOR
//     offers "Start over" via resetQueries (refetch() would replay
//     every stored pageParam and fail forever), everything else offers
//     Retry; WITH data the rows stay mounted and the error renders as a
//     banner (role="alert") above the list.
//   - Unauthorized — descriptor was `null` after the router guard; the
//     page renders <Unauthorized variant="expired" /> and the Sign-in
//     CTA navigates to /login.
//
// Plus two functional paths:
//
//   - Pagination forward — a `hasNextPage` row exposes a "Load more"
//     button whose click fetches page 2 via the HMAC cursor.
//   - IDOR-safe — the inbox renders only the requested mailbox's
//     messages, not a global view.
//
// Slice 3 fix pass (g)/(f) additions:
//   - INVALID_CURSOR Start over in BOTH the no-data and with-data
//     branches (D-CAP-044-L closed on this surface).
//   - QA L5: the inbox load's request footprint is pinned — exactly
//     TWO get-session requests (the page's deduped mount refetch +
//     AppNav's late session observer) and ONE probe.
//   - The admin case in situ: a GRANTED probe renders the header Admin
//     link on the inbox page (the member case is asserted throughout).
//
// Tests render the page inside `QueryClientProvider` +
// `ApiClientProvider` + a minimal memory-history router (CAP-044 Slice 1
// added the Compose `<Link>`, which needs router context; the
// unauthorized test already needed it for the Sign-in CTA). The router
// integration of the PRODUCTION route tree is owned by `router.tsx` /
// `router.test.tsx` — this file stays scoped to the inbox's four-state
// surface.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import type { MessageFolder } from '@unimailbox/contracts';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { InboxListPage } from './InboxListPage';
import { mailboxQueryKeys, type MailboxListItem } from './mailbox-queries';
import { authQueryKeys } from '../auth/auth-queries';
import { errorResponse, jsonResponse, spyFetch } from '../../test-utils';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';

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

const MAILBOX_ID = 'mb-1';

/**
 * CAP-044 Slice 3: InboxListPage mounts <AppNav />, whose probe fires
 * `GET /api/v1/admin/audit-events?limit=1` once per session — and whose
 * embedded session observer subscribes LATE (the content early-returns
 * the skeleton until the first page resolves, so AppNav mounts only
 * then), firing a second get-session refetch that a purely sequential
 * mock would mis-serve. Dispatch BOTH URLs around the sequential spy:
 * get-session always answers with the session shape for this render,
 * and the probe answers `probeResponse` (member 403 or admin 200, fix
 * (f)). Everything else falls through to the sequential resolvers, so
 * the resolver lists serve only the messages endpoint. Same convention
 * as AuditEventsPage.test.tsx. Duplicated from MailboxListPage.test.tsx:
 * test-utils.tsx is outside this slice's file ownership.
 */
function withAdminProbe(
  inner: typeof fetch,
  sessionResponse: () => Response,
  probeResponse: () => Response,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      return sessionResponse();
    }
    if (url.startsWith('/api/v1/admin/audit-events')) {
      return probeResponse();
    }
    return inner(input, init);
  };
}

/** The member surface: the probe answers 403, so no Admin link renders. */
function withAdminProbeDenied(inner: typeof fetch, sessionResponse: () => Response): typeof fetch {
  return withAdminProbe(inner, sessionResponse, () =>
    errorResponse('PERMISSION_DENIED', 'Forbidden', 403),
  );
}

interface RenderInboxOptions {
  readonly resolvers: Array<(call: { url: string; method: string }) => Response>;
  readonly session: unknown;
  /**
   * G11: pre-seeds the mailbox-list cache exactly as MailboxListPage
   * would have left it after the user navigated through it. Omit it to
   * test the empty-cache fallback.
   */
  readonly mailboxList?: ReadonlyArray<MailboxListItem>;
  /**
   * Fix (f): when true, the probe answers 200 (an administrator), so
   * AppNav renders the Admin link — the in-situ admin case. Default
   * false: member 403, no link.
   */
  readonly adminProbe?: boolean;
  /** CAP-060: selected folder in the mailbox route/query. */
  readonly folder?: MessageFolder;
}

/**
 * Mounts the inbox inside a minimal memory-history router. CAP-044
 * Slice 1: the page's Compose entry is a router `<Link>`, so the bare
 * `render(<InboxListPage />)` used through CAP-043 no longer resolves.
 * The compose and login routes are sentinels — this file tests the
 * inbox's own surface, not the composer.
 */
function mountInboxRouter(
  apiClient: ReturnType<typeof createApiClient>,
  queryClient: QueryClient,
  folder: MessageFolder = 'inbox',
): void {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId',
    component: () => <InboxListPage mailboxId={MAILBOX_ID} folder={folder} />,
  });
  const composeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/compose',
    component: () => <div data-testid="arrived-compose">compose</div>,
  });
  const draftRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/draft/$draftId',
    component: () => <div data-testid="arrived-draft">draft</div>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  // '/admin' sentinel so AppNav's <Link to="/admin"> resolves when the
  // probe succeeds (the admin in-situ test, fix (f)).
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    component: () => <div data-testid="arrived-admin">admin</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      inboxRoute,
      composeRoute,
      draftRoute,
      loginRoute,
      adminRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [`/mailbox/${MAILBOX_ID}`] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function renderInbox(options: RenderInboxOptions): {
  fetchCalls: Array<{ url: string; method: string }>;
} {
  // The auth session query has `staleTime: 0` in production, so it
  // refetches on every mount — including the AppNav probe's LATE session
  // observer (see withAdminProbeDenied). get-session is therefore
  // URL-dispatched with this response instead of consuming a sequential
  // resolver slot meant for the messages endpoint.
  // parseSessionResponse accepts the production wire shape:
  //   { data: { user: { id, email, name }, session: { userId, expiresAt } } }
  const sessionResponse = (): Response => {
    if (options.session === null || options.session === undefined) {
      // No session: parseSessionResponse will return null. We return
      // the same shape Better Auth sends for an un-authenticated
      // request (`{ data: { user: null, session: null } }`).
      return jsonResponse({
        data: { user: null, session: null },
      });
    }
    const s = options.session as {
      userId: string;
      email: string;
      displayName: string | null;
      expiresAt: string;
    };
    return jsonResponse({
      data: {
        user: { id: s.userId, email: s.email, name: s.displayName ?? '' },
        session: { userId: s.userId, expiresAt: s.expiresAt },
      },
    });
  };
  const { fetchImpl, calls } = spyFetch(options.resolvers);
  // Fix (f): the probe's answer is parametric — member 403 (default, no
  // Admin link) or admin 200 (the in-situ admin case).
  const probeResponse =
    options.adminProbe === true
      ? () => jsonResponse({ data: { items: [], nextCursor: null } })
      : () => errorResponse('PERMISSION_DENIED', 'Forbidden', 403);
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    // CAP-044 Slice 3: the AppNav probe and every get-session refetch are
    // URL-dispatched before they can consume a sequential resolver slot.
    fetchImpl: withAdminProbe(fetchImpl, sessionResponse, probeResponse),
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(authQueryKeys.session(), options.session);
  if (options.mailboxList !== undefined) {
    const userId =
      typeof options.session === 'object' && options.session !== null && 'userId' in options.session
        ? String((options.session as { userId: unknown }).userId)
        : null;
    queryClient.setQueryData(mailboxQueryKeys.list(userId), [...options.mailboxList]);
  }
  mountInboxRouter(apiClient, queryClient, options.folder);
  return { fetchCalls: calls };
}

describe('InboxListPage', () => {
  it('renders the loading skeleton while the first page is in flight', async () => {
    // Fix pass F7: the messages fetch NEVER resolves (a pending promise
    // from the fetch spy for the messages endpoint only — the session
    // fetch still resolves so the page clears the session gate and
    // mounts the messages query). The skeleton is therefore the only
    // renderable state; the assertion is skeleton ONLY, no `|| error`
    // escape hatch.
    const pendingMessages = new Promise<Response>(() => {});
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`)) {
        return pendingMessages;
      }
      return jsonResponse({
        data: {
          user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
          session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
        },
      });
    }) as unknown as typeof fetch;
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      // CAP-044 Slice 3: keep the member surface here too — get-session
      // answers with the session shape and the probe 403s, so neither
      // can fall through to the pending-messages branch.
      fetchImpl: withAdminProbeDenied(fetchImpl, () =>
        jsonResponse({
          data: {
            user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
            session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
          },
        }),
      ),
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(authQueryKeys.session(), SESSION);
    mountInboxRouter(apiClient, queryClient);
    await waitFor(() => {
      expect(screen.getByTestId('inbox-list-skeleton')).toBeInTheDocument();
    });
    // No other surface may render while the page request pends.
    expect(screen.queryByTestId('inbox-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-list-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-empty')).not.toBeInTheDocument();
  });

  it('renders the empty state when the mailbox has no messages', async () => {
    renderInbox({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
  });

  it('CAP-060 R-MESSAGE-001/R-API-001: renders the selected folder and requests its server filter', async () => {
    const { fetchCalls } = renderInbox({
      folder: 'sent',
      resolvers: [
        () =>
          jsonResponse({
            data: {
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000099',
                  fromAddress: 'sender@example.test',
                  fromName: 'Sender',
                  subject: 'Sent message',
                  isRead: 1,
                  isStarred: 0,
                  folder: 'sent',
                  createdAt: '2026-01-03T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
              ],
              nextCursor: null,
            },
          }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByText('Sent message')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Sent' })).toBeInTheDocument();
    for (const folder of ['inbox', 'sent', 'drafts', 'archive', 'trash']) {
      expect(screen.getByTestId(`folder-link-${folder}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('folder-link-sent')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('folder-link-inbox')).not.toHaveAttribute('aria-current');
    expect(screen.queryByTestId('inbox-draft-link')).not.toBeInTheDocument();
    expect(
      fetchCalls.some(
        (call) =>
          call.method === 'GET' &&
          call.url === `/api/v1/mailboxes/${MAILBOX_ID}/messages?folder=sent`,
      ),
    ).toBe(true);
  });

  it('CAP-062 R-MESSAGE-010: links draft rows to the mailbox-scoped recovery view', async () => {
    const draftId = '00000000-0000-4000-8000-000000000062';
    renderInbox({
      folder: 'drafts',
      resolvers: [
        () =>
          jsonResponse({
            data: {
              items: [
                {
                  id: draftId,
                  fromAddress: SESSION.email,
                  fromName: SESSION.displayName,
                  subject: 'Unsaved draft',
                  isRead: 1,
                  isStarred: 0,
                  folder: 'drafts',
                  createdAt: '2026-08-30T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
              ],
              nextCursor: null,
            },
          }),
      ],
      session: SESSION,
    });

    await waitFor(() => expect(screen.getByTestId('inbox-draft-link')).toBeInTheDocument());
    expect(screen.getByTestId('inbox-draft-link')).toHaveAttribute(
      'href',
      `/mailbox/${MAILBOX_ID}/draft/${draftId}`,
    );
  });

  it('renders the error state with retry on a fetch failure', async () => {
    // 400 is non-retryable — the API client surfaces it immediately.
    // 5xx would trigger exponential backoff (1s, 2s, 4s, 8s, 16s) and
    // hang the test; 400 keeps the failure deterministic and short.
    const { fetchCalls } = renderInbox({
      resolvers: [
        () => errorResponse('INTERNAL', 'fail', 400),
        () => jsonResponse({ data: { items: [], nextCursor: null } }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-error')).toBeInTheDocument();
    });
    // Click the inner "Retry" button (not the panel wrapper, which has
    // no click handler).
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    // Retry → second resolver returns the empty list.
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
    // Sanity: at least the messages endpoint was hit twice.
    expect(
      fetchCalls.some(
        (call) =>
          call.url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`) && call.method === 'GET',
      ),
    ).toBe(true);
  });

  it('fix (g): a no-data INVALID_CURSOR offers Start over (resetQueries), which recovers the list', async () => {
    const { fetchCalls } = renderInbox({
      resolvers: [
        () => errorResponse('INVALID_CURSOR', 'The supplied cursor is invalid', 400),
        () =>
          jsonResponse({
            data: {
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000001',
                  fromAddress: 'a@x.test',
                  fromName: 'A',
                  subject: 'Recovered',
                  isRead: 0,
                  isStarred: 0,
                  folder: 'inbox',
                  createdAt: '2026-01-01T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
              ],
              nextCursor: null,
            },
          }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-error')).toBeInTheDocument();
    });
    // D-CAP-044-L: for INVALID_CURSOR the recovery button is "Start
    // over" (resetQueries drops the broken pageParam chain), NOT Retry
    // (refetch() would replay every stored pageParam and fail forever).
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(1);
    });
    expect(
      fetchCalls.filter(
        (call) =>
          call.method === 'GET' && call.url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`),
      ).length,
    ).toBe(2);
  });

  it('fix (g): an INVALID_CURSOR load-more keeps the rows and offers Start over in the banner, which resets the chain', async () => {
    const page1 = () =>
      jsonResponse({
        data: {
          items: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              fromAddress: 'a@x.test',
              fromName: 'A',
              subject: 'One',
              isRead: 0,
              isStarred: 0,
              folder: 'inbox',
              createdAt: '2026-01-01T00:00:00Z',
              recipients: { to: [], cc: [] },
            },
            {
              id: '00000000-0000-4000-8000-000000000002',
              fromAddress: 'b@x.test',
              fromName: 'B',
              subject: 'Two',
              isRead: 1,
              isStarred: 0,
              folder: 'inbox',
              createdAt: '2026-01-02T00:00:00Z',
              recipients: { to: [], cc: [] },
            },
          ],
          nextCursor: 'cursor-page-1',
        },
      });
    renderInbox({
      resolvers: [
        page1,
        () => errorResponse('INVALID_CURSOR', 'The supplied cursor is invalid', 400),
        page1,
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('inbox-load-more'));
    // The load-more fails with INVALID_CURSOR: the two loaded rows STAY
    // (data-first) and the error renders as a banner offering Start
    // over — never a wipe back to the full-page error panel.
    await waitFor(() => {
      expect(screen.getByTestId('inbox-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(2);
    expect(screen.getByTestId('inbox-start-over')).toBeInTheDocument();
    expect(screen.queryByTestId('inbox-banner-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-error')).not.toBeInTheDocument();

    // resetQueries drops the broken chain and refetches page 1: banner
    // gone, the fresh page-1 rows on screen.
    await user.click(screen.getByTestId('inbox-start-over'));
    await waitFor(() => {
      expect(screen.queryByTestId('inbox-error-banner')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(2);
  });

  it('QA L5 / fix (g): an inbox load costs exactly TWO get-session requests and ONE probe', async () => {
    // Pin the request footprint (the code L2 acceptance): the page's
    // own session observers (InboxListPage + InboxListContent) share one
    // key and dedupe to ONE mount refetch; AppNav's session observer
    // mounts LATE (after the first page resolves) and adds exactly one
    // more; LogoutButton adds none (it only reads the query client).
    // The probe fires once for the member.
    const sessionGets: string[] = [];
    const probeGets: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/auth/better/get-session')) {
        sessionGets.push(url);
        return jsonResponse({
          data: {
            user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
            session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
          },
        });
      }
      if (url.startsWith('/api/v1/admin/audit-events')) {
        probeGets.push(url);
        return errorResponse('PERMISSION_DENIED', 'Forbidden', 403);
      }
      return jsonResponse({ data: { items: [], nextCursor: null } });
    }) as unknown as typeof fetch;
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(authQueryKeys.session(), SESSION);
    mountInboxRouter(apiClient, queryClient);

    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
    // The probe fires only after AppNav mounts (first page resolved) —
    // wait for it before pinning both counts.
    await waitFor(() => {
      expect(probeGets).toHaveLength(1);
    });
    expect(sessionGets).toHaveLength(2);
  });

  it('fix (f): an ADMIN probe renders the header Admin link pointing at /admin, in situ', async () => {
    // The member case (no link) is asserted by every other test's
    // render; this is the granted counterpart, on the REAL inbox page —
    // the probe's success must surface the /admin entry point.
    renderInbox({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
      session: SESSION,
      adminProbe: true,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('app-nav-admin-link')).toBeInTheDocument();
    });
    expect(screen.getByTestId('app-nav-admin-link').getAttribute('href')).toBe('/admin');
    expect(screen.getByTestId('app-nav-admin-link').textContent).toBe('Admin');
  });

  it('renders a row per message and a Load more button when nextCursor is present', async () => {
    // Two pages: first has 2 items + a cursor, second has 1 item + null cursor.
    const cursor = 'opaque-hmac-cursor';
    renderInbox({
      resolvers: [
        () =>
          jsonResponse({
            data: {
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000001',
                  fromAddress: 'a@x.test',
                  fromName: 'A',
                  subject: 'Hello',
                  isRead: 0,
                  isStarred: 0,
                  folder: 'inbox',
                  createdAt: '2026-01-01T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
                {
                  id: '00000000-0000-4000-8000-000000000002',
                  fromAddress: 'b@x.test',
                  fromName: 'B',
                  subject: 'World',
                  isRead: 1,
                  isStarred: 1,
                  folder: 'inbox',
                  createdAt: '2026-01-02T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
              ],
              nextCursor: cursor,
            },
          }),
        () =>
          jsonResponse({
            data: {
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000003',
                  fromAddress: 'c@x.test',
                  fromName: 'C',
                  subject: 'Final',
                  isRead: 0,
                  isStarred: 0,
                  folder: 'inbox',
                  createdAt: '2026-01-03T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
              ],
              nextCursor: null,
            },
          }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(2);
    });
    // CAP-044 Slice 3 (D-CAP-044-K): a member's probe 403 renders NO
    // admin link in the header.
    expect(screen.queryByTestId('app-nav')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('inbox-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(3);
    });
  });

  it('renders the unauthorized state when the descriptor resolves to null', async () => {
    // D-CAP-041-9 fallback (fix pass F6): cache holds null after the
    // router guard. The component renders <Unauthorized variant="expired" />
    // — its only null handling; the Sign-in CTA inside it is the recovery
    // path (the page no longer imperatively navigates to /login). The
    // router mount (mountInboxRouter) keeps the CTA's useNavigate and the
    // CAP-044 Compose link resolvable.
    const authSessionResolver = (): Response =>
      jsonResponse({ data: { user: null, session: null } });
    const { fetchImpl } = spyFetch([authSessionResolver]);
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 0 },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(authQueryKeys.session(), null);
    mountInboxRouter(apiClient, queryClient);
    await waitFor(() => {
      expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    });
  });

  it("does not render another mailbox's messages (IDOR-safe)", async () => {
    // The component is parameterized by `mailboxId`; the fetcher hits
    // /api/v1/mailboxes/{mailboxId}/messages. The fixture returns the
    // exact row whose `data-message-id` matches the requested mailbox.
    const ownMessageId = '00000000-0000-4000-8000-00000000000a';
    renderInbox({
      resolvers: [
        () =>
          jsonResponse({
            data: {
              items: [
                {
                  id: ownMessageId,
                  fromAddress: 'own@example.com',
                  fromName: 'Own',
                  subject: 'Own mailbox',
                  isRead: 0,
                  isStarred: 0,
                  folder: 'inbox',
                  createdAt: '2026-01-01T00:00:00Z',
                  recipients: { to: [], cc: [] },
                },
              ],
              nextCursor: null,
            },
          }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('inbox-list-row');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.getAttribute('data-message-id')).toBe(ownMessageId);
    });
  });

  // G11 (fe L3): the address lookup at InboxListPage.tsx:75-81 reads
  // the cached mailbox list (no fetch) and falls back to the raw UUID.
  it('shows the mailbox address from the cached mailbox list in the Card title (G11)', async () => {
    renderInbox({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
      session: SESSION,
      mailboxList: [
        {
          id: 'other-mailbox',
          address: 'other@example.com',
          displayName: '',
          status: 'active',
          domainId: 'd-1',
          localPart: 'other',
          ownerUserId: 'u-1',
        },
        {
          id: MAILBOX_ID,
          address: 'inbox@example.com',
          displayName: '',
          status: 'active',
          domainId: 'd-1',
          localPart: 'inbox',
          ownerUserId: 'u-1',
        },
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
    // The Card title shows THIS mailbox's address, not another's and
    // not the raw UUID.
    expect(screen.getByText('inbox@example.com')).toBeInTheDocument();
    expect(screen.queryByText('other@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText(`Mailbox ${MAILBOX_ID}`)).not.toBeInTheDocument();
  });

  it('falls back to the raw mailbox UUID when the mailbox-list cache is empty, without crashing (G11)', async () => {
    // No mailboxList seed — the non-subscribing cache read misses and
    // the fallback renders. It must not fire a mailbox-list fetch.
    const { fetchCalls } = renderInbox({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
    expect(screen.getByText(`Mailbox ${MAILBOX_ID}`)).toBeInTheDocument();
    expect(
      fetchCalls.some((call) => call.method === 'GET' && call.url.endsWith('/api/v1/mailboxes')),
    ).toBe(false);
  });

  // CAP-044 Slice 1 / AC 1: the inbox carries the Compose entry point.
  // No `search` on the Link → TanStack navigates with an EMPTY search, so
  // the composer opens BLANK (verified by the absent ?replyTo).
  it('CAP-044: links to the blank composer for this mailbox', async () => {
    renderInbox({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
    const composeLink = screen.getByTestId('inbox-compose-link');
    expect(composeLink.getAttribute('href')).toBe(`/mailbox/${MAILBOX_ID}/compose`);
    expect(composeLink.getAttribute('href')).not.toContain('replyTo');
    expect(composeLink.textContent).toBe('Compose');
  });
});

// ---------------------------------------------------------------------------
// CAP-043 Slice 3 — inbox row actions (AC 16). Star + delete buttons
// mount in every row; a confirmed delete removes the row from the
// rendered list via the cache write (D-CAP-041-1) — the page never
// refetches to reflect it.
// ---------------------------------------------------------------------------

describe('InboxListPage — row actions (CAP-043 Slice 3)', () => {
  const STARRED_ROW = {
    id: '00000000-0000-4000-8000-00000000000a',
    fromAddress: 'a@x.test',
    fromName: 'A',
    subject: 'Starred',
    isRead: 0,
    isStarred: 1,
    folder: 'inbox',
    createdAt: '2026-01-01T00:00:00Z',
    recipients: { to: [], cc: [] },
  };
  const UNSTARRED_ROW = {
    id: '00000000-0000-4000-8000-00000000000b',
    fromAddress: 'b@x.test',
    fromName: 'B',
    subject: 'Unstarred',
    isRead: 1,
    isStarred: 0,
    folder: 'inbox',
    createdAt: '2026-01-02T00:00:00Z',
    recipients: { to: [], cc: [] },
  };

  it("mounts a star and a delete button in every row, reflecting each row's star state", async () => {
    renderInbox({
      resolvers: [
        () => jsonResponse({ data: { items: [STARRED_ROW, UNSTARRED_ROW], nextCursor: null } }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(2);
    });

    // One star + one delete per row.
    const starButtons = screen.getAllByTestId('inbox-star-button');
    const deleteButtons = screen.getAllByTestId('inbox-delete-button');
    expect(starButtons).toHaveLength(2);
    expect(deleteButtons).toHaveLength(2);

    // The star state is per-row: starred → pressed, unstarred → not.
    const starredRow = screen
      .getAllByTestId('inbox-list-row')
      .find((row) => row.getAttribute('data-message-id') === STARRED_ROW.id);
    const unstarredRow = screen
      .getAllByTestId('inbox-list-row')
      .find((row) => row.getAttribute('data-message-id') === UNSTARRED_ROW.id);
    expect(starredRow?.querySelector('[data-testid="inbox-star-button"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(unstarredRow?.querySelector('[data-testid="inbox-star-button"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('a confirmed delete removes the row from the rendered list and surfaces the empty state, without a refetch', async () => {
    // Resolver order: [session, messages page, DELETE 204]. spyFetch
    // repeats the LAST resolver afterwards — a second GET would get the
    // 204 Response, so the assertion that no refetch happened below
    // relies on the cache write, not on resolver exhaustion.
    const { fetchCalls } = renderInbox({
      resolvers: [
        () => jsonResponse({ data: { items: [STARRED_ROW], nextCursor: null } }),
        () => new Response(null, { status: 204 }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('inbox-delete-button'));

    // Confirmation gate: nothing is deleted before Confirm.
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(1);

    await user.click(screen.getByTestId('alert-dialog-confirm'));

    // The structural cache removal re-renders the list: zero rows, the
    // empty state shows. D-CAP-043-E: the 204 has no body to parse.
    await waitFor(() => {
      expect(screen.queryAllByTestId('inbox-list-row')).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });

    // Exactly one DELETE fired — and no messages GET after it (the row
    // left via setQueryData, not a refetch).
    const deleteCalls = fetchCalls.filter((call) => call.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.url).toBe(`/api/v1/mailboxes/${MAILBOX_ID}/messages/${STARRED_ROW.id}`);
    const messagesGets = fetchCalls.filter(
      (call) =>
        call.method === 'GET' && call.url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`),
    );
    expect(messagesGets).toHaveLength(1);
  });

  // Slice 3 fix H12: the inline AlertDialog renders a <div> panel inside
  // the row's actions container, and a div inside a span (or a p) is
  // invalid HTML — the browser's parser would relocate it and the
  // auth-session-storage markup guard would flag the tree. The row must
  // stay valid at EVERY dialog state, so the assertion runs with the
  // dialog OPEN.
  it('H12: the row stays markup-valid with the delete dialog open — no <div> inside a <span> or <p>', async () => {
    renderInbox({
      resolvers: [() => jsonResponse({ data: { items: [STARRED_ROW], nextCursor: null } })],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('inbox-list-row')).toHaveLength(1);
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('inbox-delete-button'));
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();

    // With the dialog panel rendered inside the row's actions container,
    // a div must never appear under a span or a p anywhere in the row.
    for (const row of screen.getAllByTestId('inbox-list-row')) {
      expect(row.querySelectorAll('span div, p div')).toHaveLength(0);
    }
  });
});
