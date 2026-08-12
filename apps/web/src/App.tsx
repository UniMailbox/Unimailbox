import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Component, useState, type ErrorInfo, type ReactElement } from 'react';
import { createAppRouter } from './app/router';

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
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  const [router] = useState(() => createAppRouter());

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}