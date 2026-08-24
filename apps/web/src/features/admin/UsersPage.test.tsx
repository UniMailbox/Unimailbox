// apps/web — UsersPage tests.
//
// CAP-044 Slice 3 (AC 19). Route-level fetch interception (spyFetch), no
// sleeps — the AuditEventsPage.test.tsx house style. Covers:
//
//   - A member (session exists, 403 PERMISSION_DENIED) renders the
//     not-authorized state after EXACTLY ONE request — no retry loop.
//   - Rows accumulate across cursor pages via Load more, and the second
//     fetch's URL carries the cursor parameter (R-API-005).
//   - Explicit empty state.
//   - A no-data error renders the error panel; Retry recovers.
//   - A failed load-more keeps the accumulated rows and surfaces the
//     failure as a banner (role="alert") above the list — the data-first
//     ordering (Slice 2 fix pass (e) contract).
//   - An INVALID_CURSOR load-more offers Start over (resetQueries), which
//     drops the broken chain and refetches page 1.
//   - Fix (b): a never-resolving first fetch stays on the loading
//     placeholder — it must not fall through to a false empty or error
//     surface (the isPending-vs-isLoading defect class).
//   - A null session descriptor renders the expired-session fallback
//     (D-CAP-041-9), never the users list.
//
// The router integration of the PRODUCTION route tree (session guard) is
// owned by router.test.tsx; this file stays scoped to the page.
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
import { UsersPage } from './UsersPage';
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

const USERS_URL = '/api/v1/admin/users';

/** One valid row per userListItemSchema (uuid id, closed status). */
function userRow(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    email: `user-${n}@example.com`,
    displayName: `User ${n}`,
    status: 'active',
    createdAt: `2026-01-01T00:00:0${n}Z`,
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
  const usersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/users',
    component: UsersPage,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([usersRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin/users'] }),
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
  /** Pre-seed the session cache with null to hit the expired fallback. */
  readonly session?: unknown;
  /**
   * Fix (b): when true, users-list calls NEVER resolve. spyFetch
   * resolvers answer synchronously, so a never-resolving fetch needs
   * this bespoke branch (a pending promise) — it pins the first fetch
   * in flight forever to exercise the loading gate.
   */
  readonly pendingUsersFetch?: boolean;
}

/**
 * Mounts the page with a URL-dispatching fetch mock: get-session is always
 * answered with the SESSION descriptor; every other call falls through to
 * the SEQUENTIAL resolver list (spyFetch), which therefore serves only
 * users-list calls, in order. Same convention as AuditEventsPage.test.tsx.
 */
function renderUsersPage(options: RenderOptions): {
  fetchCalls: Array<{ url: string; method: string }>;
} {
  const { fetchImpl: sequentialFetch, calls } = spyFetch(options.resolvers);
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/better/get-session')) {
      calls.push({ url, method: 'GET' });
      return authSessionResolver();
    }
    if (options.pendingUsersFetch === true) {
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
  // Explicit undefined-vs-null: `??` would collapse a null (signed-out)
  // session into SESSION and never exercise the expired fallback.
  queryClient.setQueryData(
    authQueryKeys.session(),
    options.session === undefined ? SESSION : options.session,
  );
  mountAdminRouter(apiClient, queryClient);
  return { fetchCalls: calls };
}

function usersGetCount(calls: ReadonlyArray<{ url: string; method: string }>): number {
  return calls.filter((call) => call.method === 'GET' && call.url.includes(USERS_URL)).length;
}

describe('UsersPage (CAP-044 Slice 3 / AC 19)', () => {
  it('renders the not-authorized state for a member after exactly one request (no crash loop)', async () => {
    const { fetchCalls } = renderUsersPage({
      resolvers: [() => errorResponse('PERMISSION_DENIED', 'Permission denied', 403)],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument();
    });
    // The panel is a status, not an alert — a member landing here is
    // expected behavior (D-CAP-044-D: the server is the authorization
    // truth; the session descriptor carries no role signal).
    expect(screen.getByRole('status')).toBeInTheDocument();
    // The loop assertion: after the panel renders, give any would-be
    // refetch a tick to fire, then count — it must still be exactly 1.
    await waitFor(() => {
      expect(usersGetCount(fetchCalls)).toBe(1);
    });
    expect(usersGetCount(fetchCalls)).toBe(1);
  });

  it('renders a row per user with email, status, and detail, and shows no credential material', async () => {
    renderUsersPage({
      resolvers: [
        () =>
          jsonResponse({
            data: {
              items: [
                userRow(1),
                userRow(2, { status: 'banned', displayName: null }),
                userRow(3, { status: 'deleted' }),
              ],
              nextCursor: null,
            },
          }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-user-row')).toHaveLength(3);
    });
    const rows = screen.getAllByTestId('admin-user-row');
    expect(rows[0]?.getAttribute('data-user-id')).toBe('00000000-0000-4000-8000-000000000001');
    expect(rows[0]?.textContent).toContain('user-1@example.com');
    expect(rows[0]?.textContent).toContain('active');
    // A null displayName renders the em-dash sentinel, never "null".
    expect(rows[1]?.textContent).toContain('name: —');
    expect(rows[1]?.textContent).toContain('banned');
    expect(rows[2]?.textContent).toContain('deleted');
    // R-SECRET-003 client mirror: the row markup carries only the five
    // enumerated fields — no hash/credential/secret/token key text.
    for (const row of rows) {
      expect(row.textContent).not.toMatch(/hash|credential|secret|token/i);
    }
    // End of chain: no Load more.
    expect(screen.queryByTestId('admin-users-load-more')).not.toBeInTheDocument();
  });

  it('accumulates rows across cursor pages via Load more, chaining the cursor in the second URL', async () => {
    const cursor = 'opaque.hmac+cursor==';
    const { fetchCalls } = renderUsersPage({
      resolvers: [
        () => jsonResponse({ data: { items: [userRow(1), userRow(2)], nextCursor: cursor } }),
        () => jsonResponse({ data: { items: [userRow(3)], nextCursor: null } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-user-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('admin-users-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-user-row')).toHaveLength(3);
    });
    const allRows = screen.getAllByTestId('admin-user-row').map((r) => r.getAttribute('data-user-id'));
    expect(allRows).toContain('00000000-0000-4000-8000-000000000003');
    // The second fetch must carry the first page's cursor (R-API-005).
    const usersCalls = fetchCalls.filter(
      (call) => call.method === 'GET' && call.url.includes(USERS_URL),
    );
    expect(usersCalls).toHaveLength(2);
    expect(usersCalls[1]?.url).toContain(`cursor=${encodeURIComponent(cursor)}`);
    // Terminal page: the button disappears.
    await waitFor(() => {
      expect(screen.queryByTestId('admin-users-load-more')).not.toBeInTheDocument();
    });
  });

  it('renders the explicit empty state when no users exist', async () => {
    renderUsersPage({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-users-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-users-load-more')).not.toBeInTheDocument();
  });

  it('renders the error panel with retry for a non-permission failure, then recovers', async () => {
    const { fetchCalls } = renderUsersPage({
      resolvers: [
        () => errorResponse('VALIDATION_ERROR', 'bad input', 400),
        () => jsonResponse({ data: { items: [], nextCursor: null } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-error')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-not-authorized')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByTestId('admin-users-empty')).toBeInTheDocument();
    });
    expect(usersGetCount(fetchCalls)).toBe(2);
  });

  it('a failed load-more keeps accumulated rows and shows the error banner', async () => {
    renderUsersPage({
      resolvers: [
        () => jsonResponse({ data: { items: [userRow(1), userRow(2)], nextCursor: 'cursor-page-1' } }),
        () => jsonResponse({ data: { items: [userRow(3)], nextCursor: 'cursor-page-2' } }),
        // 409 is non-retryable for the ApiClient (only 5xx/429 back off),
        // so the failure surfaces immediately — no test may sleep through
        // exponential backoff (testing rules).
        () => errorResponse('UNKNOWN', 'upstream unavailable', 409),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-user-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('admin-users-load-more'));
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-user-row')).toHaveLength(3);
    });

    // The next load-more fails. The three loaded rows STAY on screen and
    // the failure surfaces as a banner above the list — never a wipe.
    await user.click(screen.getByTestId('admin-users-load-more'));
    await waitFor(() => {
      expect(screen.getByTestId('users-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getAllByTestId('admin-user-row')).toHaveLength(3);
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('users-banner-retry')).toBeInTheDocument();
  });

  it('an INVALID_CURSOR load-more offers Start over, which resets the page chain', async () => {
    renderUsersPage({
      resolvers: [
        () => jsonResponse({ data: { items: [userRow(1), userRow(2)], nextCursor: 'cursor-page-1' } }),
        () => errorResponse('INVALID_CURSOR', 'The supplied cursor is invalid', 400),
        () => jsonResponse({ data: { items: [userRow(1), userRow(2)], nextCursor: 'cursor-page-1' } }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-user-row')).toHaveLength(2);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('admin-users-load-more'));
    await waitFor(() => {
      expect(screen.getByTestId('users-error-banner')).toBeInTheDocument();
    });
    // Rows retained; the INVALID_CURSOR action is Start over — a plain
    // Retry would replay ALL stored pageParams (TanStack v5) and fail
    // forever on a broken chain.
    expect(screen.getAllByTestId('admin-user-row')).toHaveLength(2);
    expect(screen.getByTestId('users-start-over')).toBeInTheDocument();
    expect(screen.queryByTestId('users-banner-retry')).not.toBeInTheDocument();

    // resetQueries drops the broken chain and refetches page 1.
    await user.click(screen.getByTestId('users-start-over'));
    await waitFor(() => {
      expect(screen.queryByTestId('users-error-banner')).not.toBeInTheDocument();
    });
    expect(screen.getAllByTestId('admin-user-row')).toHaveLength(2);
  });

  it('fix (b): a never-resolving first fetch stays on admin-loading — no false empty, no error panel', async () => {
    renderUsersPage({
      resolvers: [],
      pendingUsersFetch: true,
    });
    // The session is pre-seeded, so the page's own query is the only
    // thing pending. The loading placeholder must persist — isPending is
    // true until data or an error exists, so a first fetch that never
    // settles (e.g. paused offline) must not fall through to the empty
    // or error surfaces while NOTHING has loaded.
    await waitFor(() => {
      expect(screen.getByTestId('admin-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-users-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-not-authorized')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-users-page')).not.toBeInTheDocument();
  });

  it('renders the expired-session fallback when the descriptor is null (D-CAP-041-9)', async () => {
    renderUsersPage({
      resolvers: [() => jsonResponse({ data: { items: [], nextCursor: null } })],
      session: null,
    });
    await waitFor(() => {
      expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    });
    // No users surface renders alongside the fallback.
    expect(screen.queryByTestId('admin-users-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-users-page')).not.toBeInTheDocument();
  });
});
