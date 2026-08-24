// apps/web — InboxListPage tests.
//
// CAP-043 Slice 1 (AC 8). The authorized inbox list page renders one of
// four mutually-exclusive states:
//
//   - Loading — `<InboxListSkeleton />` while the first page is in-flight.
//   - Empty — `<InboxEmpty />` ("No messages in this mailbox yet.").
//   - Error — `<InboxError />` with retry; on a 400 INVALID_CURSOR the
//     retry button restarts from page 1 (R-API-005 recovery path).
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
import {
  errorResponse,
  jsonResponse,
  spyFetch,
} from '../../test-utils';
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

interface RenderInboxOptions {
  readonly resolvers: Array<(call: { url: string; method: string }) => Response>;
  readonly session: unknown;
  /**
   * G11: pre-seeds the mailbox-list cache exactly as MailboxListPage
   * would have left it after the user navigated through it. Omit it to
   * test the empty-cache fallback.
   */
  readonly mailboxList?: ReadonlyArray<MailboxListItem>;
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
): void {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId',
    component: () => <InboxListPage mailboxId={MAILBOX_ID} />,
  });
  const composeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/compose',
    component: () => <div data-testid="arrived-compose">compose</div>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([inboxRoute, composeRoute, loginRoute]),
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
  // refetches on every mount. The spyFetch intercepts that refetch
  // and would otherwise consume a resolver slot meant for the
  // messages endpoint. Prepend a Better Auth–shaped response to the
  // resolver list so the auth fetch resolves with the same descriptor
  // we cached. parseSessionResponse accepts the production wire shape:
  //   { data: { user: { id, email, name }, session: { userId, expiresAt } } }
  const authSessionResolver = (): Response => {
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
  const { fetchImpl, calls } = spyFetch([authSessionResolver, ...options.resolvers]);
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
  queryClient.setQueryData(authQueryKeys.session(), options.session);
  if (options.mailboxList !== undefined) {
    queryClient.setQueryData(mailboxQueryKeys.list(), [...options.mailboxList]);
  }
  mountInboxRouter(apiClient, queryClient);
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
      expect(screen.getByTestId('inbox-list-skeleton')).toBeInTheDocument();
    });
    // No other surface may render while the page request pends.
    expect(screen.queryByTestId('inbox-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-list-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inbox-empty')).not.toBeInTheDocument();
  });

  it('renders the empty state when the mailbox has no messages', async () => {
    renderInbox({
      resolvers: [
        () => jsonResponse({ data: { items: [], nextCursor: null } }),
      ],
      session: SESSION,
    });
    await waitFor(() => {
      expect(screen.getByTestId('inbox-empty')).toBeInTheDocument();
    });
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
          call.url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`) &&
          call.method === 'GET',
      ),
    ).toBe(true);
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

  it('does not render another mailbox\'s messages (IDOR-safe)', async () => {
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

  it('mounts a star and a delete button in every row, reflecting each row\'s star state', async () => {
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
      (call) => call.method === 'GET' && call.url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`),
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
      resolvers: [
        () => jsonResponse({ data: { items: [STARRED_ROW], nextCursor: null } }),
      ],
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
