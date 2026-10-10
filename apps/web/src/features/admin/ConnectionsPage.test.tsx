// apps/web — ConnectionsPage tests.
//
// CAP-044 Slice 3 (AC 20). Route-level fetch interception (spyFetch), no
// sleeps — the AuditEventsPage.test.tsx house style. Covers:
//
//   - Rows render provider/status/label/webhook metadata; the Reveal
//     button exists ONLY on webhookConfigured rows.
//   - A member (session exists, 403 PERMISSION_DENIED) renders the
//     not-authorized state after exactly one request.
//   - The reveal flow: confirm dialog → POST to the audited reveal
//     endpoint → the secret is displayed ONCE with the audit note →
//     Hide clears it and it never returns.
//   - A reveal failure (403 without provider.sync) renders INSIDE the
//     dialog's error slot; rows stay mounted, the dialog stays open.
//   - R-SECRET-003 (the dispatch mandate): spies on the five console
//     LOG methods (log, info, warn, error, debug) plus a full
//     localStorage/sessionStorage value sweep prove the revealed secret
//     is never logged through them and never persisted to web storage
//     (other sinks — network, disk — are not observable here).
//   - Explicit empty state.
//   - A background refetch failure keeps the loaded rows and surfaces
//     the banner (data-first, Slice 2 fix pass (e) contract).
//
// Slice 3 fix pass (b)/(f) additions:
//   - A never-resolving first fetch stays on the loading placeholder —
//     no false empty or error surface (isPending-vs-isLoading).
//   - Cancel on the reveal dialog fires NO POST (the audited action is
//     deliberate — R-AUDIT-001).
//   - A reveal retry clears the previous attempt's dialog error while
//     the new attempt is pending (the mutation's onMutate).
//
// The router integration of the PRODUCTION route tree (session guard) is
// owned by router.test.tsx; this file stays scoped to the page.
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { ConnectionsPage } from './ConnectionsPage';
import { adminQueryKeys, type AdminConnection } from './admin-queries';
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

const CONNECTIONS_URL = '/api/v1/admin/connections';

/** One valid row per adminConnectionSchema (camelCase wire form). */
function connectionRow(overrides: Partial<AdminConnection> = {}): AdminConnection {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    providerKey: 'brevo',
    label: 'Primary Brevo',
    status: 'active',
    webhookConfigured: true,
    webhookUrl: 'https://hooks.example.test/brevo',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
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
  const connectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/connections',
    component: ConnectionsPage,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([connectionsRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: ['/admin/connections'] }),
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
  /** Pre-seed the connections cache to assert the error-with-data banner. */
  readonly seedConnections?: ReadonlyArray<AdminConnection>;
  /**
   * Fix (b): when true, connections-list calls NEVER resolve (spyFetch
   * resolvers answer synchronously; a never-resolving fetch needs this
   * bespoke pending-promise branch). Pins the first fetch in flight.
   */
  readonly pendingConnectionsFetch?: boolean;
  /**
   * Fix (f): when true, the SECOND and later POST never resolves. The
   * first POST still consumes the sequential resolver list (so a test
   * can serve a failure), and the in-flight retry exposes the dialog's
   * pending state deterministically.
   */
  readonly pendingSecondPost?: boolean;
}

/**
 * Mounts the page with a URL-dispatching fetch mock: get-session is always
 * answered with the SESSION descriptor; every other call falls through to
 * the SEQUENTIAL resolver list (spyFetch). Same convention as
 * AuditEventsPage.test.tsx.
 */
function renderConnectionsPage(options: RenderOptions): {
  fetchCalls: Array<{ url: string; method: string }>;
} {
  const { fetchImpl: sequentialFetch, calls } = spyFetch(options.resolvers);
  let postsSeen = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/auth/me')) {
      calls.push({ url, method: 'GET' });
      return authSessionResolver();
    }
    if (options.pendingConnectionsFetch === true && (init?.method ?? 'GET') === 'GET') {
      calls.push({ url, method: 'GET' });
      return new Promise<Response>(() => {});
    }
    if (options.pendingSecondPost === true && init?.method === 'POST') {
      postsSeen += 1;
      if (postsSeen >= 2) {
        calls.push({ url, method: 'POST' });
        return new Promise<Response>(() => {});
      }
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
  if (options.seedConnections !== undefined) {
    // Fix (a): the cache key is scoped to the signed-in user's id.
    queryClient.setQueryData(adminQueryKeys.connections(SESSION.userId), [
      ...options.seedConnections,
    ]);
  }
  mountAdminRouter(apiClient, queryClient);
  return { fetchCalls: calls };
}

describe('ConnectionsPage (CAP-044 Slice 3 / AC 20)', () => {
  it('renders a row per connection with provider, status, and webhook metadata; Reveal only when configured', async () => {
    const configured = connectionRow();
    const unconfigured = connectionRow({
      id: '00000000-0000-4000-8000-000000000002',
      providerKey: 'resend',
      label: 'Resend',
      webhookConfigured: false,
      webhookUrl: null,
    });
    renderConnectionsPage({
      resolvers: [() => jsonResponse({ data: { items: [configured, unconfigured] } })],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(2);
    });
    const rows = screen.getAllByTestId('admin-connection-row');
    expect(rows[0]?.getAttribute('data-connection-id')).toBe(configured.id);
    expect(rows[0]?.textContent).toContain('brevo');
    expect(rows[0]?.textContent).toContain('active');
    expect(rows[0]?.textContent).toContain('configured (https://hooks.example.test/brevo)');
    expect(rows[1]?.textContent).toContain('not configured');
    // The reveal affordance exists ONLY on the configured row.
    expect(screen.getByTestId(`admin-connection-reveal-${configured.id}`)).toBeInTheDocument();
    expect(
      screen.queryByTestId(`admin-connection-reveal-${unconfigured.id}`),
    ).not.toBeInTheDocument();
  });

  it('renders the not-authorized state for a member after exactly one request (no crash loop)', async () => {
    const { fetchCalls } = renderConnectionsPage({
      resolvers: [() => errorResponse('PERMISSION_DENIED', 'Permission denied', 403)],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    const connectionsGets = () =>
      fetchCalls.filter((call) => call.method === 'GET' && call.url.includes(CONNECTIONS_URL))
        .length;
    await waitFor(() => {
      expect(connectionsGets()).toBe(1);
    });
    expect(connectionsGets()).toBe(1);
  });

  it('reveals the secret once behind the confirm dialog: POST fires, value + audit note show, Hide clears it', async () => {
    const SECRET = 'whsec_live_do_not_log_9f1c';
    const row = connectionRow();
    const { fetchCalls } = renderConnectionsPage({
      resolvers: [
        () => jsonResponse({ data: { items: [row] } }),
        () =>
          jsonResponse({
            data: {
              id: row.id,
              providerKey: row.providerKey,
              label: row.label,
              webhookSecret: SECRET,
            },
          }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
    });

    const user = userEvent.setup();
    // Nothing reveals before the confirm: clicking Reveal opens the
    // dialog, no POST has fired, no secret is on screen.
    await user.click(screen.getByTestId(`admin-connection-reveal-${row.id}`));
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId(`admin-secret-revealed-${row.id}`)).not.toBeInTheDocument();

    await user.click(screen.getByTestId('alert-dialog-confirm'));

    // The audited reveal endpoint was called exactly once, via POST,
    // with the connection id path-encoded (R-AUDIT-001 server-side).
    const revealCalls = fetchCalls.filter((call) => call.method === 'POST');
    expect(revealCalls).toHaveLength(1);
    expect(revealCalls[0]?.url).toBe(`/api/v1/admin/connections/${row.id}/webhook-secret/reveal`);

    // The one-time display: value + the "shown once / audited" note,
    // and the dialog is closed.
    await waitFor(() => {
      expect(screen.getByTestId(`admin-secret-revealed-${row.id}`)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    const note = screen.getByTestId(`admin-secret-revealed-${row.id}`).textContent ?? '';
    expect(note).toContain('Shown once');
    expect(note).toContain('audit trail');

    // Hide clears the value; it does not come back.
    await user.click(screen.getByTestId(`admin-secret-hide-${row.id}`));
    expect(screen.queryByTestId(`admin-secret-revealed-${row.id}`)).not.toBeInTheDocument();
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('R-SECRET-003: the revealed secret is never logged and never persisted', async () => {
    const SECRET = 'whsec_live_never_logged_a73b';
    const row = connectionRow();
    // Spy on the five console LOG methods (log, info, warn, error,
    // debug) BEFORE the reveal so any log call the page or the query
    // layer might make is captured verbatim. The swept set is exactly
    // these five plus the two web-storage objects (asserted below) —
    // other console surfaces (table/dir/trace/…) are out of scope, as
    // are non-browser sinks.
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    );
    try {
      renderConnectionsPage({
        resolvers: [
          () => jsonResponse({ data: { items: [row] } }),
          () =>
            jsonResponse({
              data: {
                id: row.id,
                providerKey: row.providerKey,
                label: row.label,
                webhookSecret: SECRET,
              },
            }),
        ],
      });
      await waitFor(() => {
        expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
      });
      const user = userEvent.setup();
      await user.click(screen.getByTestId(`admin-connection-reveal-${row.id}`));
      await user.click(screen.getByTestId('alert-dialog-confirm'));
      await waitFor(() => {
        expect(screen.getByTestId(`admin-secret-revealed-${row.id}`)).toBeInTheDocument();
      });

      // Not in any console call (args may be objects — stringify them).
      for (const spy of spies) {
        for (const callArgs of spy.mock.calls) {
          expect(JSON.stringify(callArgs)).not.toContain(SECRET);
        }
      }
      // Not persisted anywhere the browser keeps across reloads.
      expect(window.localStorage.getItem('unimailbox:webhook-secret')).toBeNull();
      expect(window.sessionStorage.getItem('unimailbox:webhook-secret')).toBeNull();
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        expect(window.localStorage.getItem(key ?? '')).not.toContain(SECRET);
      }
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i);
        expect(window.sessionStorage.getItem(key ?? '')).not.toContain(SECRET);
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it('a failed reveal renders the error inside the dialog; rows stay mounted and the dialog stays open', async () => {
    const row = connectionRow();
    renderConnectionsPage({
      resolvers: [
        () => jsonResponse({ data: { items: [row] } }),
        () => errorResponse('PERMISSION_DENIED', 'provider.sync required', 403),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`admin-connection-reveal-${row.id}`));
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    // The failure lands in the dialog's error slot — the dialog stays
    // open (no half-revealed state) and no secret display renders.
    await waitFor(() => {
      expect(screen.getByTestId('alert-dialog-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('alert-dialog-error').textContent).toContain(
      'You do not have permission for this action.',
    );
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId(`admin-secret-revealed-${row.id}`)).not.toBeInTheDocument();
    // Rows stay mounted throughout.
    expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
  });

  it('fix (f): Cancel on the reveal dialog fires no POST and shows no secret', async () => {
    const row = connectionRow();
    const { fetchCalls } = renderConnectionsPage({
      resolvers: [
        () => jsonResponse({ data: { items: [row] } }),
        // A second resolver exists only so a fired POST would be
        // ANSWERED — the assertion is that it is never consumed.
        () =>
          jsonResponse({
            data: {
              id: row.id,
              providerKey: row.providerKey,
              label: row.label,
              webhookSecret: 'whsec_cancelled_never_fires',
            },
          }),
      ],
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`admin-connection-reveal-${row.id}`));
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('alert-dialog-cancel'));
    // The dialog closes and the audited POST never fired — the confirm
    // gate is what makes the R-AUDIT-001 row deliberate, so Cancel must
    // be request-free.
    await waitFor(() => {
      expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    });
    expect(fetchCalls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(screen.queryByTestId(`admin-secret-revealed-${row.id}`)).not.toBeInTheDocument();
  });

  it("fix (f): a reveal retry clears the previous attempt's error while the new attempt is pending", async () => {
    const row = connectionRow();
    renderConnectionsPage({
      resolvers: [
        () => jsonResponse({ data: { items: [row] } }),
        () => errorResponse('PERMISSION_DENIED', 'provider.sync required', 403),
      ],
      pendingSecondPost: true,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId(`admin-connection-reveal-${row.id}`));
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('alert-dialog-error')).toBeInTheDocument();
    });

    // Retry. The second POST NEVER resolves (pendingSecondPost), so the
    // error slot can only be empty because the mutation's onMutate
    // cleared it when the attempt started — the stale-error fix.
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('alert-dialog-error')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
  });

  it('renders the explicit empty state when no connections are configured', async () => {
    renderConnectionsPage({
      resolvers: [() => jsonResponse({ data: { items: [] } })],
    });
    await waitFor(() => {
      expect(screen.getByTestId('admin-connections-empty')).toBeInTheDocument();
    });
  });

  it('fix (b): a never-resolving first fetch stays on admin-loading — no false empty, no error panel', async () => {
    renderConnectionsPage({
      resolvers: [],
      pendingConnectionsFetch: true,
    });
    // isPending holds until data or an error exists, so a first fetch
    // that never settles (e.g. paused offline) must not fall through to
    // the empty or error surfaces while NOTHING has loaded.
    await waitFor(() => {
      expect(screen.getByTestId('admin-loading')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('admin-connections-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-not-authorized')).not.toBeInTheDocument();
    expect(screen.queryByTestId('admin-connections-page')).not.toBeInTheDocument();
  });

  it('a background refetch failure keeps the loaded rows and shows the error banner', async () => {
    const row = connectionRow();
    renderConnectionsPage({
      // The cache is seeded (seedConnections), so the mount refetch is a
      // BACKGROUND refetch: its failure must not wipe the rows.
      seedConnections: [row],
      resolvers: [() => errorResponse('UNKNOWN', 'upstream unavailable', 409)],
    });
    await waitFor(() => {
      expect(screen.getByTestId('connections-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // The seeded row is still on screen (data-first ordering).
    expect(screen.getAllByTestId('admin-connection-row')).toHaveLength(1);
    expect(screen.queryByTestId('admin-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('connections-banner-retry')).toBeInTheDocument();
  });
});
