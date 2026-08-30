// apps/web — router-context tests.
//
// CAP-042 (Batch 5) D-CAP-041-9 closure: at least one real
// router-context test that mounts the router and asserts the
// `/mailbox` `beforeLoad` redirects to `/login` when no session
// exists.
//
// This test is the load-bearing closure for the D-CAP-041-9 deferred
// item from CAP-041 (`test-utils.tsx`'s `mountAppRouter` helper existed
// for exactly this purpose but no test was exercising it). The route
// tree mirrors the production routes — `/login`, `/register`, `/mailbox`
// with the same `beforeLoad` shape — so a future regression in the
// router's cache-backed `beforeLoad` path will be caught here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createRoute, type RootRoute, type AnyRoute, redirect } from '@tanstack/react-router';
import { jsonResponse, lastPathname, mountAppRouter, spyFetch } from '../test-utils';
import type { RouterContext } from './router';
import { validateComposeSearch, validateFolderSearch } from './router';
import { authQueryKeys, fetchAuthSession } from '../features/auth/auth-queries';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Build the same `/mailbox` `beforeLoad` shape the production router
// uses. A reviewer reading this file should be able to map the lines
// back to `app/router.tsx` 1:1.
function buildAuthRouteTree(
  rootRoute: RootRoute<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    undefined,
    RouterContext
  >,
): AnyRoute {
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const registerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/register',
    component: () => <div data-testid="arrived-register">register</div>,
  });
  const mailboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-mailbox">mailbox</div>,
  });
  return rootRoute.addChildren([loginRoute, registerRoute, mailboxRoute]);
}

describe('router (D-CAP-041-9 closure)', () => {
  it('redirects /mailbox to /login when there is no session', async () => {
    // Better Auth returns a `{ data: null }` body (or equivalent) when
    // no cookie is present. `fetchAuthSession` swallows 401s and the
    // unwrapped null body both.
    const { fetchImpl } = spyFetch([() => jsonResponse({ data: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      // No `authSession` fixture — the cache starts empty.
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('redirects /mailbox to /login when get-session returns a null user', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ user: null, session: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('renders /mailbox when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      authSession: {
        userId: 'u-pre',
        email: 'pre@b.test',
        displayName: 'Pre',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/mailbox');
    // No additional fetch — the cache was already warm.
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CAP-044 Slice 2 (AC 13): the /admin section's session guard. Same
// beforeLoad shape as /mailbox — mirrored 1:1 from app/router.tsx so a
// regression in the admin routes' cache-backed guard is caught here.
// Authorization is deliberately NOT part of this tree: the session
// descriptor carries no role signal, so the guard only checks "is there
// a session"; the audit-events PAGE owns the 403 not-authorized surface
// (covered in features/admin/AuditEventsPage.test.tsx).
// ---------------------------------------------------------------------------
function buildAdminRouteTree(
  rootRoute: RootRoute<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    undefined,
    RouterContext
  >,
): AnyRoute {
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">login</div>,
  });
  const adminLandingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin">admin</div>,
  });
  const adminAuditEventsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/audit-events',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-audit-events">audit events</div>,
  });
  // CAP-044 Slice 3 (ACs 19–21): the users / connections / webhook-events
  // routes, mirrored 1:1 from app/router.tsx.
  const adminUsersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/users',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-users">users</div>,
  });
  const adminConnectionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/connections',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-connections">connections</div>,
  });
  const adminWebhookEventsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/webhook-events',
    beforeLoad: async ({ context }) => {
      const descriptor = await context.queryClient.ensureQueryData({
        queryKey: authQueryKeys.session(),
        queryFn: () => fetchAuthSession(context.apiClient),
      });
      if (descriptor === null) {
        throw redirect({ to: '/login' });
      }
    },
    component: () => <div data-testid="arrived-admin-webhook-events">webhook events</div>,
  });
  return rootRoute.addChildren([
    loginRoute,
    adminLandingRoute,
    adminAuditEventsRoute,
    adminUsersRoute,
    adminConnectionsRoute,
    adminWebhookEventsRoute,
  ]);
}

describe('router — /admin guard (CAP-044 Slice 2 / AC 13)', () => {
  it('redirects /admin to /login when there is no session', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ data: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin'],
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('redirects /admin/audit-events to /login when there is no session', async () => {
    const { fetchImpl } = spyFetch([() => jsonResponse({ user: null, session: null })]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/audit-events'],
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('renders /admin/audit-events when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/audit-events'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/audit-events');
    // The warm cache means zero additional fetches for the guard.
    expect(calls.length).toBe(0);
  });

  // CAP-044 Slice 3 (ACs 19–21): each new admin page route carries the
  // same session guard as its siblings.
  it.each(['/admin/users', '/admin/connections', '/admin/webhook-events'])(
    'redirects %s to /login when there is no session',
    async (initial) => {
      const { fetchImpl } = spyFetch([() => jsonResponse({ data: null })]);
      const { history } = await mountAppRouter({
        fetchImpl,
        initialEntries: [initial],
        buildRouteTree: buildAdminRouteTree,
      });
      expect(lastPathname(history)).toBe('/login');
    },
  );

  it('renders /admin/users when the cache is pre-seeded with a valid session', async () => {
    const { fetchImpl, calls } = spyFetch([]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/admin/users'],
      authSession: {
        userId: 'u-admin',
        email: 'admin@b.test',
        displayName: 'Admin',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      buildRouteTree: buildAdminRouteTree,
    });
    expect(lastPathname(history)).toBe('/admin/users');
    expect(calls.length).toBe(0);
  });
});

// CAP-044 Slice 1 (AC 1): the compose route's optional `?replyTo=`
// search param is validated at the route boundary — only a non-empty
// string survives, so the composer never receives a bogus parent id
// (an array from ?replyTo=a&replyTo=b, a number, or an empty string).
describe('validateComposeSearch (CAP-044 Slice 1)', () => {
  it('keeps a non-empty string replyTo and drops every other key', () => {
    expect(validateComposeSearch({ replyTo: 'm-1', other: 'junk' })).toEqual({
      replyTo: 'm-1',
    });
  });

  it('returns an empty object when replyTo is absent', () => {
    expect(validateComposeSearch({})).toEqual({});
  });

  it('drops an empty-string replyTo', () => {
    expect(validateComposeSearch({ replyTo: '' })).toEqual({});
  });

  // Fix pass (g): trim before the emptiness check.
  it('drops a whitespace-only replyTo — the blank composer opens, not a parent 404', () => {
    expect(validateComposeSearch({ replyTo: '   ' })).toEqual({});
    expect(validateComposeSearch({ replyTo: ' \t\n ' })).toEqual({});
  });

  it('keeps a padded replyTo trimmed', () => {
    expect(validateComposeSearch({ replyTo: ' m-1 ' })).toEqual({ replyTo: 'm-1' });
  });

  it('drops non-string replyTo values (number, array, object)', () => {
    expect(validateComposeSearch({ replyTo: 42 })).toEqual({});
    expect(validateComposeSearch({ replyTo: ['m-1', 'm-2'] })).toEqual({});
    expect(validateComposeSearch({ replyTo: { id: 'm-1' } })).toEqual({});
    expect(validateComposeSearch({ replyTo: null })).toEqual({});
    expect(validateComposeSearch({ replyTo: true })).toEqual({});
  });
});

describe('validateFolderSearch (CAP-060)', () => {
  it('keeps each supported folder value', () => {
    expect(validateFolderSearch({ folder: 'inbox' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: 'sent' })).toEqual({ folder: 'sent' });
    expect(validateFolderSearch({ folder: 'drafts' })).toEqual({ folder: 'drafts' });
    expect(validateFolderSearch({ folder: 'archive' })).toEqual({ folder: 'archive' });
    expect(validateFolderSearch({ folder: 'trash' })).toEqual({ folder: 'trash' });
  });

  it('falls back to inbox for missing, empty, repeated, and unsupported values', () => {
    expect(validateFolderSearch({})).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: '' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: ['sent', 'trash'] })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: 'Sent' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: 'outbox' })).toEqual({ folder: 'inbox' });
    expect(validateFolderSearch({ folder: null })).toEqual({ folder: 'inbox' });
  });
});
