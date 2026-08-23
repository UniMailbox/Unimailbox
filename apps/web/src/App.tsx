import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Component, useMemo, useState, type ErrorInfo, type ReactElement } from 'react';
import { createAppRouter } from './app/router';
import { ApiClientProvider } from './infrastructure/api/client-provider';
import { createApiClient } from './infrastructure/api/client';
import { useSetupSession } from './features/setup/setup-session-store';

// Top-level error boundary — catches the throw that escapes a route's
// `defaultErrorComponent` (e.g. an error during provider setup, an error
// from React 19's concurrent render). Renders a typed, actionable
// message; never a stack trace. Per .claude/rules/coding.md §Errors.
interface ErrorBoundaryProps {
  readonly children: ReactElement;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged via the browser console so a developer can correlate with
    // React DevTools. No remote sink lands in CAP-001.
    console.error('App render error', error, info);
  }

  override render(): ReactElement {
    if (this.state.error !== null) {
      const message = this.state.error.message;
      return (
        <main className="unimailbox-stub" role="alert">
          <h1>Something went wrong</h1>
          <p>{message}</p>
          <p>
            <a href="/">Reload</a>
          </p>
        </main>
      );
    }
    return this.props.children;
  }
}

export function App(): ReactElement {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Architecture H7 (CAP-041 fix): the API client owns retry policy
          // for 5xx / 429. Queries must NOT retry implicitly — double
          // retries would surface wrong error codes and wrong UX.
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: false,
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );
  // B2 (CAP-041 fix): construct the API client ONCE. The token getter is
  // bound to the live Zustand store so the client always sees the current
  // session token, but the client identity is stable across renders —
  // preserving `retryDelaysByCall` and any in-flight retry state. The same
  // instance is passed to `<ApiClientProvider>` (for step components via
  // `useApiClient()`) AND to `createAppRouter` (for `beforeLoad` via the
  // router's context).
  const apiClient = useMemo(
    () =>
      createApiClient({
        baseUrl: '',
        getSessionToken: () => useSetupSession.getState().sessionToken,
      }),
    [],
  );
  const [router] = useState(() => createAppRouter(apiClient, queryClient));

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
