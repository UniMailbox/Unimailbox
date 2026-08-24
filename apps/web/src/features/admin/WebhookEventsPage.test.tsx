// apps/web — WebhookEventsPage tests.
//
// CAP-044 Slice 3 (AC 21). Route-level fetch interception (spyFetch), no
// sleeps — the AuditEventsPage.test.tsx house style. Covers:
//
//   - Rows render delivery metadata (event type, status, connection,
//     message, timestamp) from the LIVE snake_case CAP-025 wire shape.
//   - A member (session exists, 403 PERMISSION_DENIED) renders the
//     not-authorized state after exactly one request.
//   - A background refetch failure keeps the loaded rows and surfaces
//     the banner (data-first, Slice 2 fix pass (e) contract).
//   - Explicit empty state.
//   - Fix (b): a never-resolving first fetch stays on the loading
//     placeholder — no false empty or error surface.
//
// No INVALID_CURSOR branch exists on this surface — the endpoint is not
// cursor-paginated (server-truncated), so there is no Load-more surface
// to test here.
//
// The router integration of the PRODUCTION route tree (session guard) is
// owned by router.test.tsx; this file stays scoped to the page.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { WebhookEventsPage } from './WebhookEventsPage';
import { adminQueryKeys, type WebhookEventDelivery } from './admin-queries';
import { errorResponse, jsonResponse, spyFetch } from '../../test-utils';

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

const WEBHOOK_EVENTS_URL = '/api/v1/admin/webhook-events';

/** One valid row per webhookEventDeliverySchema (snake_case wire form). */
function webhookEventRow(
  overrides: Partial<WebhookEventDelivery> = {},
): WebhookEventDelivery {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    connection_id: '00000000-0000-4000-8000-00000000000a',
    event_type: 'message.sent',
    message_id: '00000000-0000-4000-8000-00000000000b',
    status: 'delivered',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function authSessionResolver(): Response {
  return jsonResponse({
    data: {
      user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
      session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
    },
  });
}

function mountAdminRouter(
  apiClient: ReturnType<typeof createApiClient>,
  queryClient: QueryClient,
): void {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const webhookEventsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/webhook-events',
    component: WebhookEventsPage,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([webhookEventsRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin/webhook-events'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

interface RenderOptions {
  readonly resolvers: Array<(call: { url: string; method: string }) => Response>;
  /** Pre-seed the webhook-events cache to assert the error-with-data banner. */
  readonly seedEvents?: ReadonlyArray<WebhookEventDelivery>;
  /**
   * Fix (b): when true, webhook-events calls NEVER resolve (spyFetch
   * resolvers answer synchronously; a never-resolving fetch needs this
   * bespoke pending-promise branch). Pins the first fetch in flight.
   */
  readonly pendingEventsFetch?: boolean;
}

/**
 * Mounts the page with a URL-dispatching fetch mock: get-session is always
 * answered with the SESSION descriptor; every other call falls through to
 * the SEQUENTIAL resolver list (spyFetch). Same convention as
 * AuditEventsPage.test.tsx.
 */
function renderWebhookEventsPage(options: RenderOptions): {
  fetchCalls: Array<{ url: string; method: string }>;
} {
  const { fetchImpl: sequentialFetch, calls } = spyFetch(options.resolvers);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      calls.push({ url, method: 'GET' });
      return authSessionResolver();
    }
    if (options.pendingEventsFetch === true) {
      calls.push({ url, method: 'GET' });
      return new Promise<Response>(() => {});
    }
    return sequentialFetch(input, init);
  };
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(authQueryKeys.session(), SESSION);
  if (options.seedEvents !== undefined) {
    // Fix (a): the cache key is scoped to the signed-in user's id.
    queryClient.setQueryData(adminQueryKeys.webhookEvents(SESSION.userId), [
      ...options.seedEvents,
    ]);
  }
  mountAdminRouter(apiClient, queryClient);
  return { fetchCalls: calls };
}

describe('WebhookEventsPage (CAP-044 Slice 3 / AC 21)', () => {
  it('renders a row per delivery with event type, status, connection, and message metadata', async () => {
    const withMessage = webhookEventRow();
    const withoutMessage = webhookEventRow({
      id: '00000000-0000-4000-8000-000000000002',
      event_type: 'webhook.configured',
      message_id: null,
      status: 'pending',
      created_at: '2026-01-02T00:00:00Z',
    });
    renderWebhookEventsPage({
      resolvers: [() => jsonResponse({ data: { items: [withMessage, withoutMessage] } })],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-webhook-event-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('admin-webhook-event-row');
    expect(rows[0]?.getAttribute('data-event-id')).toBe(withMessage.id);
    expect(rows[0]?.textContent).toContain('message.sent');
    expect(rows[0]?.textContent).toContain('delivered');
    expect(rows[0]?.textContent).toContain(`connection: ${withMessage.connection_id}`);
    expect(rows[0]?.textContent).toContain(`message: ${withMessage.message_id}`);
    // A null message_id renders the em-dash sentinel, never "null".
    expect(rows[1]?.textContent).toContain('message: —');
    expect(rows[1]?.textContent).toContain('pending');
  });

  it('renders the not-authorized state for a member after exactly one request (no crash loop)', async () => {
    const { fetchCalls } = renderWebhookEventsPage({
      resolvers: [() => errorResponse('PERMISSION_DENIED', 'Permission denied', 403)],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    const eventGets = () =>
      fetchCalls.filter(
        (call) => call.method === 'GET' && call.url.includes(WEBHOOK_EVENTS_URL),
      ).length;
    await waitFor(() => {
      expect(eventGets()).toBe(1);
    });
    expect(eventGets()).toBe(1);
  });

  it('a background refetch failure keeps the loaded rows and shows the error banner', async () => {
    const row = webhookEventRow();
    renderWebhookEventsPage({
      // The cache is seeded (seedEvents), so the mount refetch is a
      // BACKGROUND refetch: its failure must not wipe the rows.
      seedEvents: [row],
      resolvers: [() => errorResponse('UNKNOWN', 'upstream unavailable', 409)],
    });
    await waitFor(() => {
      expect(screen.getByTestId('webhook-events-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The seeded row is still on screen (data-first ordering).
    expect(screen.getAllByTestId('admin-webhook-event-row')).toHaveLength(1);
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('webhook-events-banner-retry')).toBeInTheDocument();
  });

  it('fix (b): a never-resolving first fetch stays on admin-loading — no false empty, no error panel', async () => {
    renderWebhookEventsPage({
      resolvers: [],
      pendingEventsFetch: true,
    });
    // isPending holds until data or an error exists, so a first fetch
    // that never settles (e.g. paused offline) must not fall through to
    // the empty or error surfaces while NOTHING has loaded.
    await waitFor(() => {
      expect(screen.getByTestId('admin-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-webhook-events-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-not-authorized')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-webhook-events-page')).not.toBeInTheDocument();
  });

  it('renders the explicit empty state when no deliveries are recorded', async () => {
    renderWebhookEventsPage({
      resolvers: [() => jsonResponse({ data: { items: [] } })],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-webhook-events-empty')).toBeInTheDocument();
    });
  });
});
