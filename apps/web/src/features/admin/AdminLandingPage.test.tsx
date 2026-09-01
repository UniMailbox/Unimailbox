// apps/web — AdminLandingPage tests.
//
// CAP-066: the /admin landing links to every admin page — audit events
// plus the existing admin pages and managed domains. The links
// are plain router Links; each target page owns its permission surface
// (covered in its own test file). This file pins the index contract.
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
      ]),
      history: createMemoryHistory({ initialEntries: ['/admin'] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
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
    ];
    for (const link of expected) {
      const element = screen.getByTestId(link.testid);
      expect(element.getAttribute('href')).toBe(link.href);
    }
  });
});
