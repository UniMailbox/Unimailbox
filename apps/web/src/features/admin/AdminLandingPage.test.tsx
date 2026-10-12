// apps/web — AdminLandingPage tests.
//
// CAP-066: the /admin landing links to every admin page — audit events
// plus the existing admin pages and managed domains. The links
// are plain router Links; each target page owns its permission surface
// (covered in its own test file). This file pins the index contract.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { AdminLandingPage } from './AdminLandingPage';

afterEach(() => {
  cleanup();
});

describe('AdminLandingPage links (CAP-044 Slice 3)', () => {
  it('links to audit events, users, connections, and webhook events', async () => {
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const adminRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin',
      component: AdminLandingPage,
    });
    const auditEventsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/audit-events',
      component: () => <div>audit</div>,
    });
    const usersRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/users',
      component: () => <div>users</div>,
    });
    const connectionsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/connections',
      component: () => <div>connections</div>,
    });
    const webhookEventsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/webhook-events',
      component: () => <div>webhook events</div>,
    });
    const domainsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/domains',
      component: () => <div>domains</div>,
    });
    const rolesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/roles',
      component: () => <div>roles</div>,
    });
    const signaturesRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/signatures',
      component: () => <div>signatures</div>,
    });
    const settingsRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/admin/settings',
      component: () => <div>settings</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([
        adminRoute,
        auditEventsRoute,
        usersRoute,
        connectionsRoute,
        webhookEventsRoute,
        domainsRoute,
        rolesRoute,
        signaturesRoute,
        settingsRoute,
        createRoute({
          getParentRoute: () => rootRoute,
          path: '/admin/ai',
          component: () => <div>AI</div>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ['/admin'] }),
    });
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (input) => {
        const url = String(input);
        if (url.includes('/auth/me')) {
          return new Response(
            JSON.stringify({
              data: {
                user: { id: 'u-admin', email: 'admin@example.com', name: 'Admin' },
                session: { userId: 'u-admin', expiresAt: '2099-01-01T00:00:00Z' },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/admin/overview')) {
          return new Response(
            JSON.stringify({
              data: {
                scope: { domainId: null, domainName: null },
                stats: {
                  totalMessages: 0,
                  unreadMessages: 0,
                  receivedMessages: 0,
                  sentMessages: 0,
                  draftMessages: 0,
                  mailboxCount: 0,
                  domainCount: 0,
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );

    // The router resolves the route asynchronously — wait for the page
    // before asserting the links.
    await waitFor(() => {
      expect(screen.getByTestId('admin-landing')).toBeInTheDocument();
    });

    const expected: ReadonlyArray<{ readonly testid: string; readonly href: string }> = [
      { testid: 'admin-audit-events-link', href: '/admin/audit-events' },
      { testid: 'admin-users-link', href: '/admin/users' },
      { testid: 'admin-connections-link', href: '/admin/connections' },
      { testid: 'admin-webhook-events-link', href: '/admin/webhook-events' },
      { testid: 'admin-domains-link', href: '/admin/domains' },
      { testid: 'admin-roles-link', href: '/admin/roles' },
      { testid: 'admin-signatures-link', href: '/admin/signatures' },
      { testid: 'admin-settings-link', href: '/admin/settings' },
      { testid: 'admin-ai-link', href: '/admin/ai' },
    ];
    for (const link of expected) {
      const element = screen.getByTestId(link.testid);
      expect(element.getAttribute('href')).toBe(link.href);
    }
  });
});
