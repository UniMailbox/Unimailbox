// apps/web — API client provider.
//
// CAP-041 fix (B2 + orchestrator architectural decision): the singleton
// `ApiClient` is constructed exactly once at `App.tsx` via `useMemo` and
// passed down as the `client` prop. The provider here is now a thin
// React-Context bridge: it consumes the prop and nothing else. This
// guarantees:
//
//   - The `ApiClient` survives any number of re-renders of its parent
//     (e.g. `useSetupSession` changes the token, but the client identity
//     is stable, so `retryDelaysByCall` and any in-flight retry state
//     are preserved).
//   - Step components read the client via `useApiClient()` (render-time
//     hook, safe inside React).
//   - The router's `beforeLoad` reads the client via the router's own
//     `context` (no React hook, safe outside React renders).
//
// The provider no longer calls `createApiClient(...)` itself. Test
// harnesses inject a client through the `client` prop (see
// `test-utils.tsx`).
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { ApiClient } from './client';

const ApiClientContext = createContext<ApiClient | null>(null);

export interface ApiClientProviderProps {
  readonly children: ReactNode;
  readonly client: ApiClient;
}

export function ApiClientProvider({
  children,
  client,
}: ApiClientProviderProps): ReactElement {
  return (
    <ApiClientContext.Provider value={client}>
      {children}
    </ApiClientContext.Provider>
  );
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === null) {
    throw new Error('useApiClient must be used inside <ApiClientProvider>');
  }
  return client;
}