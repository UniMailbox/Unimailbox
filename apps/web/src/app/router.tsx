// apps/web router — code-based TanStack Router.
// CAP-001 stub: `/`, `/setup`, and a `*` catch-all. Real feature routes land
// with later capabilities.
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
} from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import type { ReactElement } from 'react';

function DefaultPending(): ReactElement {
  return (
    <main className="unimailbox-stub">
      <p>Loading…</p>
    </main>
  );
}

function DefaultError({ error }: ErrorComponentProps): ReactElement {
  // .claude/rules/coding.md §Errors — typed error surface, never a stack
  // trace. The error envelope from the API carries a stable `code` field;
  // a non-typed throw surfaces its message only.
  const message =
    error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <main className="unimailbox-stub" role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <main className="unimailbox-stub">
      <h1>404</h1>
      <p>Page not found.</p>
      <p>
        <Link to="/">Back to home</Link>
      </p>
    </main>
  ),
  pendingComponent: DefaultPending,
  errorComponent: DefaultError,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => (
    <main className="unimailbox-stub">
      <h1>Unimailbox</h1>
      <p>The client is wired. Feature pages land with later capabilities.</p>
    </main>
  ),
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: () => (
    <main className="unimailbox-stub">
      <h1>Setup</h1>
      <p>Setup wizard lands with CAP-006+.</p>
    </main>
  ),
});

const routeTree = rootRoute.addChildren([indexRoute, setupRoute]);

export type AppRouter = typeof routeTree;

export function createAppRouter() {
  return createRouter({ routeTree, defaultPreload: false });
}