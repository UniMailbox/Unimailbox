// apps/web — MessageDetailPage tests.
//
// CAP-043 Slice 2 (AC 11 + AC 12). Covers:
//
//   - the detail surface: subject / from / to / cc / date / text body,
//     headers collapsed by default, thread panel listing the thread's
//     messages oldest-first with the active one highlighted and
//     clickable (router navigation to the sibling detail);
//   - auto mark-read (AC 12): fires PATCH .../read exactly ONCE per
//     mount, carries an Idempotency-Key header (minted by ApiClient —
//     D-CAP-041-2), does not re-fire on re-render, and does not fire
//     at all for an already-read message;
//   - the inbox-cache flip (R-MESSAGE-005): after mark-read success the
//     inbox infinite-query entry for this message turns isRead → 1
//     without a refetch (targeted setQueryData);
//   - the four-state surface: skeleton while pending, error + retry,
//     expired-session fallback (D-CAP-041-9).
//
// The page renders <Link> and the thread panel uses useNavigate, so
// every test mounts inside a real TanStack Router memory-history tree
// (same pattern as the InboxListPage unauthorized test). The fetch
// harness dispatches by URL+method (the page fires session / detail /
// thread / PATCH in parallel — sequential resolvers would be racy) and
// captures request headers so the Idempotency-Key is assertable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from '@tanstack/react-router';
import type { AnyRouter } from '@tanstack/react-router';
import type { MessageListItem, MessageListResponse } from '@unimailbox/contracts';
import { MessageDetailPage } from './MessageDetailPage';
import { formatLocalDateTime } from '../../components/ui/LocalDateTime';
import { mailboxQueryKeys } from './mailbox-queries';
import { authQueryKeys } from '../auth/auth-queries';
import { jsonResponse, errorResponse } from '../../test-utils';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';

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
const MESSAGE_ID = '00000000-0000-4000-8000-00000000000a';
const ROOT_ID = '00000000-0000-4000-8000-00000000000b';

const DETAIL = {
  id: MESSAGE_ID,
  fromAddress: 'sender@example.com',
  fromName: 'Sender Name',
  subject: 'Quarterly report',
  htmlBody: '',
  textBody: 'The plain-text report body.',
  messageIdHeader: '<reply-1@example.com>',
  inReplyToHeader: '<root@example.com>',
  referencesHeader: '<root@example.com>',
  status: 'delivered',
  isRead: 0,
  isStarred: 0,
  folder: 'inbox',
  createdAt: '2026-02-02T00:00:00Z',
  recipients: {
    to: [{ address: 'me@example.com', displayName: 'Me' }],
    cc: [{ address: 'cc@example.com', displayName: 'CC Person' }],
  },
};

const DETAIL_ATTACHMENT = {
  id: '00000000-0000-4000-8000-00000000000c',
  filename: 'report.txt',
  contentType: 'text/plain',
  sizeBytes: 42,
  disposition: 'attachment' as const,
  contentId: null,
};

const DETAIL_WITH_ATTACHMENTS = {
  ...DETAIL,
  attachments: [DETAIL_ATTACHMENT],
};

const ROOT_THREAD_ITEM = {
  id: ROOT_ID,
  fromAddress: 'sender@example.com',
  fromName: 'Sender Name',
  subject: 'Thread root',
  isRead: 1,
  isStarred: 0,
  folder: 'inbox',
  createdAt: '2026-02-01T00:00:00Z',
  recipients: { to: [], cc: [] },
};

const ACTIVE_THREAD_ITEM: MessageListItem = {
  id: MESSAGE_ID,
  fromAddress: 'sender@example.com',
  fromName: 'Sender Name',
  subject: 'Quarterly report',
  isRead: 0,
  isStarred: 0,
  folder: 'inbox',
  createdAt: '2026-02-02T00:00:00Z',
  recipients: { to: [], cc: [] },
};

const THREAD = {
  rootId: '<root@example.com>',
  // Oldest-first, as the API contract (AC 10) returns them.
  items: [ROOT_THREAD_ITEM, ACTIVE_THREAD_ITEM],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Fetch harness: URL+method dispatch with header capture.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

interface RouteHandler {
  match: (url: string, method: string) => boolean;
  response: (call: CapturedRequest) => Response;
}

function dispatchFetch(routes: ReadonlyArray<RouteHandler>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      // happy-dom preserves the setter's casing ('Idempotency-Key'), so
      // normalize here — HTTP header names are case-insensitive and the
      // assertions below use lowercase keys.
      for (const [key, value] of new Headers(init.headers).entries()) {
        headers[key.toLowerCase()] = value;
      }
    }
    const call: CapturedRequest = { url, method, headers };
    calls.push(call);
    const route = routes.find((r) => r.match(url, method));
    if (route === undefined) {
      // 400 (not 5xx): a missing test route must not trigger the
      // client's 5xx retry backoff and hang the test.
      return errorResponse('TEST_NO_ROUTE', `no route for ${method} ${url}`, 400);
    }
    return route.response(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function sessionRoute(options: { session: unknown }): RouteHandler {
  return {
    match: (url) => url.includes('/api/v1/auth/me'),
    response: () => {
      if (options.session === null || options.session === undefined) {
        return jsonResponse({ data: { user: null, session: null } });
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
    },
  };
}

function detailRoute(respond: () => Response): RouteHandler {
  return {
    // The detail URL is the exact message path WITHOUT a /thread
    // suffix and without the PATCH /read suffix.
    match: (url, method) =>
      method === 'GET' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`,
    response: respond,
  };
}

function threadRoute(): RouteHandler {
  return {
    match: (url, method) =>
      method === 'GET' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/thread`,
    response: () => jsonResponse({ data: THREAD }),
  };
}

function markReadRoute(): RouteHandler {
  return {
    match: (url, method) =>
      method === 'PATCH' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/read`,
    response: () => jsonResponse({ data: { ok: true } }),
  };
}

function siblingDetailRoute(): RouteHandler {
  return {
    match: (url, method) =>
      method === 'GET' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${ROOT_ID}`,
    response: () =>
      jsonResponse({
        data: { ...DETAIL, id: ROOT_ID, subject: 'Thread root', isRead: 1 },
      }),
  };
}

// ---------------------------------------------------------------------------
// Mount harness.
// ---------------------------------------------------------------------------

interface RenderDetailOptions {
  readonly routes: ReadonlyArray<RouteHandler>;
  readonly session?: unknown;
  readonly seedInboxWithActiveMessage?: boolean;
  readonly initialPath?: string;
  readonly accessToken?: string;
}

async function renderDetailPage(options: RenderDetailOptions): Promise<{
  calls: CapturedRequest[];
  queryClient: QueryClient;
  router: AnyRouter;
  rerender: ReturnType<typeof render>['rerender'];
  history: ReturnType<typeof createMemoryHistory>;
}> {
  const { fetchImpl, calls } = dispatchFetch(options.routes);
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => options.accessToken ?? null,
    fetchImpl,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  // null is an explicitly unauthenticated fixture, not a missing option.
  queryClient.setQueryData(
    authQueryKeys.session(),
    options.session === undefined ? SESSION : options.session,
  );
  if (options.seedInboxWithActiveMessage === true) {
    // Pre-seed the inbox infinite-query cache exactly as the inbox page
    // would have left it: one page holding the active message unread.
    queryClient.setQueryData(mailboxQueryKeys.messages(MAILBOX_ID, SESSION.userId), {
      pages: [{ items: [{ ...ACTIVE_THREAD_ITEM }], nextCursor: null }],
      pageParams: [undefined],
    } satisfies InfiniteData<MessageListResponse>);
  }

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const detailRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/messages/$messageId',
    component: () => {
      const params = useParams({ strict: false });
      return <MessageDetailPage mailboxId={params.mailboxId} messageId={params.messageId} />;
    },
  });
  const inboxRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId',
    component: () => <div data-testid="arrived-inbox">inbox</div>,
  });
  // CAP-044 Slice 1: the page's Reply action links to the composer with
  // ?replyTo=<messageId>; a sentinel keeps that destination resolvable.
  const composeRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/compose',
    component: () => <div data-testid="arrived-compose">compose</div>,
  });
  const loginRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const history = createMemoryHistory({
    initialEntries: [options.initialPath ?? `/mailbox/${MAILBOX_ID}/messages/${MESSAGE_ID}`],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      detailRouteEntry,
      inboxRouteEntry,
      composeRouteEntry,
      loginRouteEntry,
    ]),
    history,
  });
  await router.load();

  const result = render(<RouterProvider router={router} />, {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>{children}</ApiClientProvider>
      </QueryClientProvider>
    ),
  });

  return {
    calls,
    queryClient,
    router,
    rerender: result.rerender,
    history,
  };
}

function detailBody(overrides: Partial<typeof DETAIL> = {}): typeof DETAIL {
  return { ...DETAIL, ...overrides };
}

describe('MessageDetailPage', () => {
  it('R-API-001/R-API-002 renders non-empty htmlBody in the sanitized HTML surface', async () => {
    await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() =>
          jsonResponse({
            data: detailBody({
              htmlBody: '<p>Rendered HTML body</p>',
              textBody: 'Plain-text fallback that must not render here.',
              isRead: 1,
            }),
          }),
        ),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-html-body')).toBeInTheDocument();
    });
    expect(screen.getByTestId('message-html-body')).toHaveTextContent('Rendered HTML body');
    expect(screen.queryByTestId('message-body')).not.toBeInTheDocument();
  });

  it('R-ATTACHMENT-001/R-ATTACHMENT-006 integrates ordered attachment controls into detail', async () => {
    await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: DETAIL_WITH_ATTACHMENTS })),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    const row = screen.getByTestId('message-attachment');
    expect(row).toHaveTextContent('report.txt');
    expect(screen.getByTestId('message-attachment-download')).toHaveAttribute('type', 'button');
  });

  it('loads a MIME CID image with the in-memory Bearer token and renders no remote image', async () => {
    const inline = {
      ...DETAIL_ATTACHMENT,
      contentType: 'image/png',
      disposition: 'inline' as const,
      contentId: '<logo@example.test>',
      sizeBytes: 4,
    };
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:authenticated-cid'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      const { calls } = await renderDetailPage({
        accessToken: 'memory-access-token',
        routes: [
          sessionRoute({ session: SESSION }),
          detailRoute(() =>
            jsonResponse({
              data: {
                ...DETAIL,
                htmlBody:
                  '<img src="cid:logo@example.test" alt="logo"><img src="https://remote.example/pixel" alt="remote">',
                attachments: [inline],
              },
            }),
          ),
          threadRoute(),
          markReadRoute(),
          {
            match: (url, method) =>
              method === 'GET' &&
              url === `/api/v1/mailboxes/${MAILBOX_ID}/attachments/${inline.id}/download`,
            response: () => new Response(new Uint8Array([1, 2, 3, 4]).buffer),
          },
        ],
      });
      await waitFor(() => {
        expect(screen.getByAltText('logo')).toHaveAttribute('src', 'blob:authenticated-cid');
      });
      expect(screen.getByAltText('remote')).not.toHaveAttribute('src');
      const binaryRequest = calls.find((call) => call.url.endsWith(`/${inline.id}/download`));
      expect(binaryRequest?.headers.authorization).toBe('Bearer memory-access-token');
      expect(screen.getByTestId('message-attachment-preview')).toHaveAttribute(
        'src',
        'blob:authenticated-cid',
      );
    } finally {
      cleanup();
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('renders subject, from, to, cc, date, body, and headers collapsed by default', async () => {
    await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('message-body').textContent).toBe('The plain-text report body.');
    expect(screen.getByTestId('message-from').textContent).toBe('Sender Name <sender@example.com>');
    expect(screen.getByTestId('message-to').textContent).toContain('me@example.com');
    expect(screen.getByTestId('message-cc').textContent).toContain('cc@example.com');
    expect(screen.getByTestId('message-date').textContent).toBe(
      formatLocalDateTime('2026-02-02T00:00:00Z'),
    );

    // Headers section exists and is collapsed by default (AC 11).
    const headers = screen.getByTestId('message-headers');
    expect(headers.tagName).toBe('DETAILS');
    expect(headers).not.toHaveAttribute('open');
    expect(screen.getByTestId('message-header-message-id').textContent).toBe(
      '<reply-1@example.com>',
    );
  });

  it('renders the formatted from address exactly once (G10) — no Card-description duplication', async () => {
    await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    const formatted = 'Sender Name <sender@example.com>';
    // The Card description used to render `From ${formatted}` on top of
    // the message-from row — it must be gone.
    expect(screen.queryByText(`From ${formatted}`)).not.toBeInTheDocument();
    // Exactly one element renders the bare formatted string. (Thread
    // items append ` · <date>` so they never exact-match.)
    expect(screen.getAllByText(formatted)).toHaveLength(1);
    expect(screen.getByTestId('message-from')).toHaveTextContent(formatted);
  });

  // CAP-044 Slice 1 / AC 5: the Reply action opens the composer carrying
  // this message's id in ?replyTo — the composer prefills from it via
  // D-CAP-044-C (the prefill itself is covered in ComposeEmail.test.tsx).
  it('CAP-044: links to the composer with ?replyTo=<messageId>', async () => {
    await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    const replyLink = screen.getByTestId('message-reply-link');
    expect(replyLink.getAttribute('href')).toBe(
      `/mailbox/${MAILBOX_ID}/compose?replyTo=${MESSAGE_ID}`,
    );
    expect(replyLink.textContent).toBe('Reply');
  });

  it('lists the thread oldest-first with the active message highlighted, and navigates to a sibling on click', async () => {
    const { history } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        threadRoute(),
        siblingDetailRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-thread-panel')).toBeInTheDocument();
    });
    const items = screen.getAllByTestId('message-thread-item');
    expect(items).toHaveLength(2);
    // Oldest-first: root first, active second.
    expect(items[0]?.getAttribute('data-message-id')).toBe(ROOT_ID);
    expect(items[0]?.getAttribute('data-active')).toBe('false');
    expect(items[1]?.getAttribute('data-message-id')).toBe(MESSAGE_ID);
    expect(items[1]?.getAttribute('data-active')).toBe('true');

    // The click handler lives on the button inside each <li> (the active
    // one is disabled); click the sibling's button, not the list item.
    const [siblingButton] = screen.getAllByTestId('message-thread-item-button');
    if (siblingButton === undefined) {
      throw new Error('expected a sibling thread button to click');
    }
    expect(siblingButton).toBeEnabled();
    const user = userEvent.setup();
    await user.click(siblingButton);
    await waitFor(() => {
      expect(history.location.pathname).toBe(`/mailbox/${MAILBOX_ID}/messages/${ROOT_ID}`);
    });
  });

  it('fires mark-read exactly once on mount with an Idempotency-Key header, and never re-fires on re-render', async () => {
    const { calls, rerender, router } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        threadRoute(),
        markReadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-thread-panel')).toBeInTheDocument();
    });

    const patchCalls = calls.filter((call) => call.method === 'PATCH');
    expect(patchCalls).toHaveLength(1);
    // D-CAP-041-2: ApiClient mints the key; one mutation per mount
    // means one fresh UUID key per mount (AC 12).
    expect(patchCalls[0]?.headers['idempotency-key']).toMatch(UUID_PATTERN);

    // Force an explicit re-render (thread arrival + mutation success
    // already re-rendered by now); the PATCH count must stay at one.
    rerender(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('does not fire mark-read when the message is already read', async () => {
    const { calls } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody({ isRead: 1 }) })),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('message-thread-panel')).toBeInTheDocument();
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  it('flips the inbox list cache entry to read after mark-read succeeds (R-MESSAGE-005)', async () => {
    const { calls, queryClient } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        threadRoute(),
        markReadRoute(),
      ],
      seedInboxWithActiveMessage: true,
    });

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    });

    // Targeted cache write — the inbox page that seeded the cache is
    // not mounted here, so the only way this flips is setQueryData.
    await waitFor(() => {
      const cached = queryClient.getQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(MAILBOX_ID, SESSION.userId),
      );
      const item = cached?.pages[0]?.items.find((i) => i.id === MESSAGE_ID);
      expect(item?.isRead).toBe(1);
    });
    // No inbox refetch was issued alongside the cache write.
    expect(
      calls.some(
        (call) => call.method === 'GET' && call.url.endsWith(`/mailboxes/${MAILBOX_ID}/messages`),
      ),
    ).toBe(false);
  });

  // G6 (fe M1 / code M1): the mark-read success must flip the DETAIL
  // cache too. Without it, the cached detail kept `isRead: 0`, so every
  // reopen of an already-read message re-fired a redundant PATCH.
  it('reopens an already-read message without re-firing mark-read (G6) — the detail cache flips too', async () => {
    // The detail route reports server truth: unread until the PATCH
    // lands, read afterwards.
    let markedRead = false;
    const { calls, queryClient, history } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody({ isRead: markedRead ? 1 : 0 }) })),
        threadRoute(),
        {
          match: (url, method) =>
            method === 'PATCH' &&
            url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/read`,
          response: () => {
            markedRead = true;
            return jsonResponse({ data: { ok: true } });
          },
        },
      ],
    });

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    });
    // Wait for the G6 cache flip to land before navigating — the write
    // happens in the mutation's onSuccess, a tick after the response.
    await waitFor(() => {
      const cached = queryClient.getQueryData<{ isRead: number }>(
        mailboxQueryKeys.message(MAILBOX_ID, MESSAGE_ID, SESSION.userId),
      );
      expect(cached?.isRead).toBe(1);
    });

    // Navigate away (inbox) and back (reopen). The cached detail now
    // says isRead: 1, so the effect must not fire again.
    history.push(`/mailbox/${MAILBOX_ID}`);
    await waitFor(() => {
      expect(screen.getByTestId('arrived-inbox')).toBeInTheDocument();
    });
    history.push(`/mailbox/${MAILBOX_ID}/messages/${MESSAGE_ID}`);
    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    // The thread panel renders only after the reopen's queries settled —
    // any would-be second PATCH would have surfaced by then.
    await waitFor(() => {
      expect(screen.getByTestId('message-thread-panel')).toBeInTheDocument();
    });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  // G7 (fe M2 / code L7): the route reuses the component instance on a
  // param change, so the ref-guard's sibling behavior is proven, not
  // assumed — one PATCH per unread sibling, none further for the old one.
  it('marks each unread sibling read exactly once when the route reuses the component on param change (G7)', async () => {
    const SIBLING_ID = '00000000-0000-4000-8000-00000000000c';
    // Server truth per message: isRead flips after that message's PATCH.
    const readByMessage = new Map<string, boolean>([
      [MESSAGE_ID, false],
      [SIBLING_ID, false],
    ]);
    const detailFor = (id: string): RouteHandler => ({
      match: (url, method) =>
        method === 'GET' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${id}`,
      response: () =>
        jsonResponse({
          data: detailBody({
            id,
            subject: `Sibling ${id}`,
            isRead: readByMessage.get(id) === true ? 1 : 0,
          }),
        }),
    });
    const markReadFor = (id: string): RouteHandler => ({
      match: (url, method) =>
        method === 'PATCH' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${id}/read`,
      response: () => {
        readByMessage.set(id, true);
        return jsonResponse({ data: { ok: true } });
      },
    });
    const anyThreadRoute: RouteHandler = {
      match: (url, method) => method === 'GET' && url.endsWith('/thread'),
      response: () => jsonResponse({ data: THREAD }),
    };

    const { calls, history } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailFor(MESSAGE_ID),
        detailFor(SIBLING_ID),
        anyThreadRoute,
        markReadFor(MESSAGE_ID),
        markReadFor(SIBLING_ID),
      ],
    });

    const patchesTo = (id: string): number =>
      calls.filter(
        (call) =>
          call.method === 'PATCH' &&
          call.url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${id}/read`,
      ).length;

    await waitFor(() => {
      expect(patchesTo(MESSAGE_ID)).toBe(1);
    });

    // Same route, different param — the component instance is reused.
    history.push(`/mailbox/${MAILBOX_ID}/messages/${SIBLING_ID}`);
    await waitFor(() => {
      expect(patchesTo(SIBLING_ID)).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    expect(patchesTo(MESSAGE_ID)).toBe(1);
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
  });

  // G8 (code M3): a thread-query failure must not take the page down.
  it('renders the body with an inline thread-error panel when the thread fetch fails, and retry refetches (G8)', async () => {
    let threadAttempts = 0;
    const { calls } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => jsonResponse({ data: detailBody() })),
        {
          match: (url, method) =>
            method === 'GET' &&
            url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/thread`,
          response: () => {
            threadAttempts += 1;
            return threadAttempts === 1
              ? errorResponse('INTERNAL', 'thread boom', 400)
              : jsonResponse({ data: THREAD });
          },
        },
      ],
    });

    // The message body renders even though the thread rejected.
    await waitFor(() => {
      expect(screen.getByTestId('message-body')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('message-thread-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('message-thread-panel')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByTestId('message-thread-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('message-thread-error')).not.toBeInTheDocument();
    // Retry re-issued the thread fetch (initial + retry = 2).
    expect(
      calls.filter((call) => call.method === 'GET' && call.url.endsWith('/thread')),
    ).toHaveLength(2);
  });

  // G9 (fe L1 / code L3): a failed mark-read is ignorable (page keeps
  // rendering) but not silent — one warn carrying both ids + the error.
  it('warns once with both ids when mark-read fails, and the page keeps rendering (G9)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await renderDetailPage({
        routes: [
          sessionRoute({ session: SESSION }),
          detailRoute(() => jsonResponse({ data: detailBody() })),
          threadRoute(),
          {
            match: (url, method) =>
              method === 'PATCH' &&
              url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/read`,
            // 400: non-retryable, surfaces immediately (no backoff).
            response: () => errorResponse('INTERNAL', 'mark-read boom', 400),
          },
        ],
      });

      await waitFor(() => {
        expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledTimes(1);
      });
      const firstCall = warnSpy.mock.calls[0];
      expect(firstCall).toBeDefined();
      const [warnMessage, warnDetail] = firstCall ?? [];
      expect(String(warnMessage)).toContain('mark-message-read');
      expect(warnDetail).toMatchObject({
        mailboxId: MAILBOX_ID,
        messageId: MESSAGE_ID,
        code: 'INTERNAL',
        message: 'Something went wrong. Please try again.',
      });
      // No crash — the body is still rendered.
      expect(screen.getByTestId('message-body')).toBeInTheDocument();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('renders the skeleton while the detail fetch is pending, and nothing else', async () => {
    const pendingDetail = new Promise<Response>(() => {});
    await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => pendingDetail as unknown as Response),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-skeleton')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('message-detail-page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-detail-error')).not.toBeInTheDocument();
  });

  it('renders the error state with retry when the detail fetch fails', async () => {
    let detailAttempts = 0;
    const { calls } = await renderDetailPage({
      routes: [
        sessionRoute({ session: SESSION }),
        detailRoute(() => {
          detailAttempts += 1;
          return detailAttempts === 1
            ? errorResponse('INTERNAL', 'detail boom', 400)
            : jsonResponse({ data: detailBody() });
        }),
        threadRoute(),
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-error')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByTestId('message-detail-page')).toBeInTheDocument();
    });
    // Detail endpoint hit exactly twice (initial + retry).
    expect(
      calls.filter(
        (call) =>
          call.method === 'GET' &&
          call.url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`,
      ),
    ).toHaveLength(2);
  });

  it('renders the expired-session fallback when the descriptor is null (D-CAP-041-9)', async () => {
    await renderDetailPage({
      routes: [sessionRoute({ session: null })],
      session: null,
    });

    await waitFor(() => {
      expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('message-detail-page')).not.toBeInTheDocument();
  });
});
