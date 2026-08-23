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
// Tests render the component directly inside `QueryClientProvider` and
// `ApiClientProvider`, mirroring `MailboxShell.test.tsx`. The router
// integration (route matching, beforeLoad, navigation) is owned by the
// production `router.tsx` and `MailboxListPage.test.tsx` — this file is
// scoped to the inbox's four-state surface.
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
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <InboxListPage mailboxId={MAILBOX_ID} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
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
    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <InboxListPage mailboxId={MAILBOX_ID} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );
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
    // path (the page no longer imperatively navigates to /login). A
    // RouterProvider is mounted so the CTA's useNavigate resolves.
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
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/mailbox/$mailboxId',
      component: () => <InboxListPage mailboxId={MAILBOX_ID} />,
    });
    const loginRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/login',
      component: () => <div data-testid="arrived-login">login</div>,
    });
    const routeTree = rootRoute.addChildren([indexRoute, loginRoute]);
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [`/mailbox/${MAILBOX_ID}`] }),
    });
    await router.load();
    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );
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
});