// apps/web — AuditEventsPage tests.
//
// CAP-044 Slice 2 (AC 13/14; CAP-033 absorbed, D-CAP-044-E). Route-level
// fetch interception (spyFetch), no sleeps — CAP-043/CAP-044 house style.
//
// Covers the AC 14 contract:
//   - A member (session exists, 403 PERMISSION_DENIED from the server)
//     renders the not-authorized state after EXACTLY ONE request — no
//     API crash loop (queries do not retry). Reachable via role="status".
//   - Pagination accumulates rows across cursor pages (flatMap), and the
//     second fetch's URL carries the cursor parameter (fix (g)).
//   - The filter form commits only on Apply and drives the query string.
//   - A half resource pair is caught client-side (inline message, no
//     second request).
//   - Explicit empty state.
//
// Slice 2 fix pass (e) additions:
//   - A no-data error renders the error panel WITH the filter form
//     mounted; correcting an invalid actorUserId and Applying recovers
//     (new filter value = new query key = fresh first page).
//   - A failed load-more keeps the accumulated rows on screen and
//     surfaces the failure as a banner (role="alert") above the list.
//   - INVALID_CURSOR on a load-more offers Start over (resetQueries),
//     which drops the broken chain and refetches page 1.
//
// The router integration of the PRODUCTION route tree (session guard)
// is owned by router.test.tsx; this file stays scoped to the page.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { AuditEventsPage } from './AuditEventsPage';
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

const AUDIT_URL = '/api/v1/admin/audit-events';

/** One valid row per auditEventSchema (uuid id, closed action). */
function auditRow(n: number): Record<string, string | null> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    actorUserId: SESSION.userId,
    action: 'message.send',
    resourceType: 'message',
    resourceId: `message-${n}`,
    requestId: `req-${n}`,
    metadata: `{"n":${n}}`,
    ip: null,
    createdAt: `2026-01-01T00:00:0${n}Z`,
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
  const auditRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/audit-events',
    component: AuditEventsPage,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([auditRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin/audit-events'] }),
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
}

/**
 * Mounts the page with a URL-dispatching fetch mock: get-session is
 * always answered with the SESSION descriptor; every other call falls
 * through to the SEQUENTIAL resolver list (spyFetch), which therefore
 * serves only audit-events calls, in order. The page mounts its auth
 * refetch and its first-page fetch in the same commit, so a purely
 * sequential mock would couple the test to observer scheduling.
 */
function renderAuditEvents(options: RenderOptions): {
  fetchCalls: Array<{ url: string; method: string }>;
} {
  const { fetchImpl: sequentialFetch, calls } = spyFetch(options.resolvers);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      calls.push({ url, method: 'GET' });
      return authSessionResolver();
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
  mountAdminRouter(apiClient, queryClient);
  return { fetchCalls: calls };
}

function auditGetCount(calls: ReadonlyArray<{ url: string; method: string }>): number {
  return calls.filter(
    (call) => call.method === 'GET' && call.url.includes(AUDIT_URL),
  ).length;
}

describe('AuditEventsPage (CAP-044 Slice 2 / AC 14)', () => {
  it('renders the not-authorized state for a member after exactly one request (no crash loop)', async () => {
    // AC 14: the session exists (a signed-in member) but the server
    // denies audit.read with 403 PERMISSION_DENIED. The page must show
    // the not-authorized panel and must NOT hammer the endpoint —
    // queries do not retry, so one request is the whole footprint.
    const { fetchCalls } = renderAuditEvents({
      resolvers: [() => errorResponse('PERMISSION_DENIED', 'Permission denied', 403)],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument();
    });
    // Fix (e): the panel is a status, not an alert — a member landing
    // here is expected behavior, not an error to act on.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('admin-not-authorized-message').textContent).toContain(
      'administrator',
    );
    // The loop assertion: after the panel renders, give any would-be
    // refetch a tick to fire, then count — it must still be exactly 1.
    await waitFor(() => {
      expect(auditGetCount(fetchCalls)).toBe(1);
    });
    expect(auditGetCount(fetchCalls)).toBe(1);
  });

  it('accumulates rows across cursor pages via Load more, chaining the cursor in the second URL (fix (g))', async () => {
    // Characters that URLSearchParams percent-encodes, so the assertion
    // below proves the cursor VALUE rode the request — not merely that a
    // second resolver was served.
    const cursor = 'opaque.hmac+cursor==';
    const { fetchCalls } = renderAuditEvents({
      resolvers: [
        () => jsonResponse({ data: { items: [auditRow(1), auditRow(2)], nextCursor: cursor } }),
        () => jsonResponse({ data: { items: [auditRow(3)], nextCursor: null } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('audit-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(3);
    });
    const secondPage = screen.getAllByTestId('audit-event-row').map((r) => r.getAttribute('data-event-id'));
    expect(secondPage).toContain('00000000-0000-4000-8000-000000000003');
    // Fix (g): inspect the spy's call arguments — the second fetch must
    // carry the first page's cursor as a query parameter (R-API-005).
    const auditCalls = fetchCalls.filter(
      (call) => call.method === 'GET' && call.url.includes(AUDIT_URL),
    );
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[1]?.url).toContain(`cursor=${encodeURIComponent(cursor)}`);
  });

  it('commits filters only on Apply and drives the query string', async () => {
    const actor = '00000000-0000-4000-8000-00000000000b';
    const { fetchCalls } = renderAuditEvents({
      resolvers: [
        () => jsonResponse({ data: { items: [auditRow(1)], nextCursor: null } }),
        () => jsonResponse({ data: { items: [auditRow(2)], nextCursor: null } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(1);
    });
    // Before Apply, only the unfiltered page was requested.
    expect(auditGetCount(fetchCalls)).toBe(1);
    const firstAuditCall = fetchCalls.find(
      (call) => call.method === 'GET' && call.url.includes(AUDIT_URL),
    );
    expect(firstAuditCall?.url.endsWith(AUDIT_URL)).toBe(true);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Actor user id'), actor);
    await user.click(screen.getByTestId('audit-apply-filters'));
    await waitFor(() => {
      expect(auditGetCount(fetchCalls)).toBe(2);
    });
    const filteredCall = fetchCalls.find(
      (call) => call.url.includes(`${AUDIT_URL}?`) && call.url.includes(`actorUserId=${actor}`),
    );
    expect(filteredCall).toBeDefined();
    // The filtered response replaced the rows.
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(1);
      expect(
        screen.getAllByTestId('audit-event-row')[0]?.getAttribute('data-event-id'),
      ).toBe('00000000-0000-4000-8000-000000000002');
    });
  });

  it('rejects a half resource pair inline, without a second request', async () => {
    const { fetchCalls } = renderAuditEvents({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-events-empty')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Resource type'), 'message');
    await user.click(screen.getByTestId('audit-apply-filters'));
    expect(screen.getByTestId('audit-filter-error')).toBeInTheDocument();
    expect(screen.getByTestId('audit-filter-error').textContent).toContain('together');
    // No request fired for the invalid half-pair.
    expect(auditGetCount(fetchCalls)).toBe(1);
  });

  it('renders the explicit empty state when no rows match', async () => {
    renderAuditEvents({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
    });
    await waitFor(() => {
      expect(screen.getByTestId('audit-events-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('audit-load-more')).not.toBeInTheDocument();
  });

  it('renders the error panel with retry for a non-permission failure', async () => {
    const { fetchCalls } = renderAuditEvents({
      resolvers: [
        () => errorResponse('VALIDATION_ERROR', 'bad input', 400),
        () => jsonResponse({ data: { items: [], nextCursor: null } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-not-authorized')).not.toBeInTheDocument();
    // Fix (e): the error panel keeps the filter form mounted so the
    // filters remain correctable without Retry.
    expect(screen.getByTestId('audit-filters')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByTestId('audit-events-empty')).toBeInTheDocument();
    });
    expect(auditGetCount(fetchCalls)).toBe(2);
  });

  it('fix (e): keeps the filter form mounted on a no-data error and recovers by correcting the actor id', async () => {
    const goodActor = '00000000-0000-4000-8000-00000000000b';
    const { fetchCalls } = renderAuditEvents({
      resolvers: [
        () => jsonResponse({ data: { items: [auditRow(1)], nextCursor: null } }),
        () => errorResponse('VALIDATION_ERROR', 'actorUserId must be a uuid', 400),
        () => jsonResponse({ data: { items: [auditRow(2)], nextCursor: null } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(1);
    });

    // Apply a malformed actor id: the client sends it, the server's zod
    // schema rejects it with 400. The old branch order rendered a
    // dead-end error panel with the form UNMOUNTED; the fix keeps the
    // form mounted so the value can be corrected.
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Actor user id'), 'not-a-uuid');
    await user.click(screen.getByTestId('audit-apply-filters'));
    await waitFor(() => {
      expect(screen.getByTestId('admin-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-filters')).toBeInTheDocument();
    expect(screen.getByTestId('admin-error-panel')).toBeInTheDocument();

    // Correct the value and Apply — a new filter value is a new query
    // key, so the fresh first page loads without touching Retry.
    await user.clear(screen.getByLabelText('Actor user id'));
    await user.type(screen.getByLabelText('Actor user id'), goodActor);
    await user.click(screen.getByTestId('audit-apply-filters'));
    await waitFor(() => {
      expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(1);
    });
    expect(
      screen.getAllByTestId('audit-event-row')[0]?.getAttribute('data-event-id'),
    ).toBe('00000000-0000-4000-8000-000000000002');
    const correctedCall = fetchCalls.find(
      (call) => call.method === 'GET' && call.url.includes(`actorUserId=${goodActor}`),
    );
    expect(correctedCall).toBeDefined();
  });

  it('fix (e): a failed load-more keeps accumulated rows and shows the error banner', async () => {
    renderAuditEvents({
      resolvers: [
        () =>
          jsonResponse({
            data: { items: [auditRow(1), auditRow(2)], nextCursor: 'cursor-page-1' },
          }),
        () => jsonResponse({ data: { items: [auditRow(3)], nextCursor: 'cursor-page-2' } }),
        // 409 is a non-retryable status for the ApiClient (only 5xx/429
        // back off), so the failure surfaces immediately — a 500 here
        // would sit in the client's exponential backoff for ~31s and no
        // test may sleep that long (testing rules).
        () => errorResponse('UNKNOWN', 'upstream unavailable', 409),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('audit-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(3);
    });

    // The next load-more fails. The three loaded rows STAY on screen
    // (data-first ordering) and the failure surfaces as a banner above
    // the list — never a full-page wipe back to an error panel.
    await user.click(screen.getByTestId('audit-load-more'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByTestId('audit-event-row')).toHaveLength(3);
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    // The banner offers a plain Retry for a transient failure.
    expect(screen.getByTestId('audit-banner-retry')).toBeInTheDocument();
  });

  it('fix (e): an INVALID_CURSOR load-more offers Start over, which resets the page chain', async () => {
    renderAuditEvents({
      resolvers: [
        () =>
          jsonResponse({
            data: { items: [auditRow(1), auditRow(2)], nextCursor: 'cursor-page-1' },
          }),
        () => errorResponse('INVALID_CURSOR', 'The supplied cursor is invalid', 400),
        () =>
          jsonResponse({
            data: { items: [auditRow(1), auditRow(2)], nextCursor: 'cursor-page-1' },
          }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('audit-event-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('audit-load-more'));
    await waitFor(() => {
      expect(screen.getByTestId('audit-error-banner')).toBeInTheDocument();
    });
    // Rows retained; the INVALID_CURSOR action is Start over — a plain
    // Retry would replay ALL stored pageParams (TanStack v5) and fail
    // forever on a broken chain.
    expect(screen.getAllByTestId('audit-event-row')).toHaveLength(2);
    expect(screen.getByTestId('audit-start-over')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-banner-retry')).not.toBeInTheDocument();

    // resetQueries drops the broken chain and refetches page 1.
    await user.click(screen.getByTestId('audit-start-over'));
    await waitFor(() => {
      expect(screen.queryByTestId('audit-error-banner')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('audit-event-row')).toHaveLength(2);
  });
});
