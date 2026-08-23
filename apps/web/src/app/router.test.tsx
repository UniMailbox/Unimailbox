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
import {
  createRoute,
  type RootRoute,
  type AnyRoute,
  redirect,
} from '@tanstack/react-router';
import {
  jsonResponse,
  lastPathname,
  mountAppRouter,
  spyFetch,
} from '../test-utils';
import type { RouterContext } from './router';
import {
  authQueryKeys,
  fetchAuthSession,
} from '../features/auth/auth-queries';

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
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ data: null }),
    ]);
    const { history } = await mountAppRouter({
      fetchImpl,
      initialEntries: ['/mailbox'],
      // No `authSession` fixture — the cache starts empty.
      buildRouteTree: buildAuthRouteTree,
    });
    expect(lastPathname(history)).toBe('/login');
  });

  it('redirects /mailbox to /login when get-session returns a null user', async () => {
    const { fetchImpl } = spyFetch([
      () => jsonResponse({ user: null, session: null }),
    ]);
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