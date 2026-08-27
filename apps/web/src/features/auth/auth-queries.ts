// apps/web — auth TanStack Query hooks.
//
// CAP-042 (Batch 5) AC 20 + AC 22. The browser's auth surface:
// - `fetchAuthSession` (GET /api/v1/auth/better/get-session) → reads the
//   HttpOnly cookie via the browser's `credentials: 'include'` fetch,
//   returns an `AuthSessionDescriptor` or `null`.
// - `authSessionQuery()` reads the cached descriptor (D-CAP-041-1).
// - `useSignInMutation` / `useSignOutMutation` / `useRegisterMutation`
//   mutate the session through Better Auth (sign-in/sign-out) or the
//   legacy application registration endpoint.
//
// Better Auth is the canonical sign-in surface for the application. Its
// response shape is owned by Better Auth (CAP-042 ADR-008 / R-API-002
// spirit). The `parseSessionResponse` parser narrows `unknown` into the
// typed descriptor without inventing a second contract model — it
// accepts the shapes Better Auth 1.7.1 emits and rejects anything else
// as `null`. A future contracts-package schema for this descriptor is a
// follow-up (logged as a gap in the implementer report).
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { ApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { type AuthSessionDescriptor, setAuthSession, clearAuthSession } from './auth-session-store';

export const authQueryKeys = {
  all: ['auth'] as const,
  session: () => [...authQueryKeys.all, 'session'] as const,
};

/**
 * Better Auth 1.7.1's `getSession` returns one of:
 *  - `{ user: null, session: null }` when no cookie is present;
 *  - `{ user: { id, email, name, ... }, session: { userId, expiresAt, ... } }`
 *    when a valid session cookie is present;
 *  - the JSON body `null` directly.
 *
 * The Hono wrapper at `http/routes/better-auth.ts` forwards Better Auth's
 * response verbatim; the JSON parse in `ApiClient.fetch` returns whatever
 * the body held. We accept every variant the framework actually emits
 * and reject anything else to `null` so the router's `beforeLoad` can
 * treat `null` as "redirect to /login".
 */
export function parseSessionResponse(response: unknown): AuthSessionDescriptor | null {
  if (response === null || response === undefined) return null;
  const outer = response as { data?: unknown };
  const payload = outer && typeof outer === 'object' && 'data' in outer ? outer.data : response;
  if (payload === null || payload === undefined) return null;
  if (typeof payload !== 'object') return null;
  const obj = payload as { user?: unknown; session?: unknown };
  if (obj.user === null || obj.user === undefined) return null;
  if (obj.session === null || obj.session === undefined) return null;
  if (typeof obj.user !== 'object' || typeof obj.session !== 'object') return null;
  const user = obj.user as { id?: unknown; email?: unknown; name?: unknown };
  const session = obj.session as { userId?: unknown; expiresAt?: unknown };
  if (typeof user.id !== 'string' || user.id.length === 0) return null;
  if (typeof user.email !== 'string' || user.email.length === 0) return null;
  if (typeof session.userId !== 'string' || session.userId.length === 0) return null;
  if (typeof session.expiresAt !== 'string' || session.expiresAt.length === 0) return null;
  const rawName = user.name;
  const displayName = typeof rawName === 'string' && rawName.length > 0 ? rawName : null;
  return {
    userId: user.id,
    email: user.email,
    displayName,
    expiresAt: session.expiresAt,
  };
}

/**
 * Fetcher for /api/v1/auth/better/get-session.
 *
 * The browser carries the HttpOnly cookie automatically; `ApiClient`
 * does not inject any header. A 401 (no cookie) maps to `null` so the
 * router's `beforeLoad` treats it as "redirect to /login". Network
 * errors and 5xx propagate so an error boundary can show them.
 */
export async function fetchAuthSession(
  apiClient: ApiClient,
): Promise<AuthSessionDescriptor | null> {
  try {
    const response = await apiClient.fetch<unknown>('/api/v1/auth/better/get-session');
    return parseSessionResponse(response);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

/**
 * Read-only query hook for the auth session. The router's `beforeLoad`
 * warms the same cache via `queryClient.ensureQueryData({ queryKey: ... })`,
 * so by the time MailboxShell mounts the value is in cache and a single
 * GET serves both navigation and render (D-CAP-041-1).
 */
export function authSessionQuery(): UseQueryResult<AuthSessionDescriptor | null, ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: authQueryKeys.session(),
    queryFn: () => fetchAuthSession(apiClient),
    staleTime: 0,
  });
}

/**
 * Input for the sign-in mutation. The schema lives in the LoginPage's
 * react-hook-form resolver (zod), not here — the wire shape matches
 * Better Auth's POST /sign-in/email payload.
 */
export interface AuthSignInInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Sign-in mutation. POST /api/v1/auth/better/sign-in/email — the response
 * sets the HttpOnly session cookie. We then re-fetch the descriptor and
 * write it to the in-memory store so the UI re-renders. The cookie itself
 * is never read by JavaScript (R-SECRET-003).
 */
export function useSignInMutation(): UseMutationResult<
  AuthSessionDescriptor,
  ApiError,
  AuthSignInInput
> {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AuthSignInInput): Promise<AuthSessionDescriptor> => {
      await apiClient.fetch('/api/v1/auth/better/sign-in/email', {
        method: 'POST',
        body: { email: input.email, password: input.password },
      });
      const descriptor = await fetchAuthSession(apiClient);
      if (descriptor === null) {
        throw new ApiError(
          'SESSION_NOT_RESOLVED',
          'Session cookie was set but get-session returned no user',
          500,
        );
      }
      return descriptor;
    },
    onSuccess: async (descriptor) => {
      // CAP-042 Batch 8 (M-2 fix): `setQueryData` writes the fresh
      // descriptor into the cache synchronously. The prior
      // `invalidateQueries({ queryKey: authQueryKeys.session() })` was
      // redundant — it marked the cache stale so the next
      // `ensureQueryData` in the router's `beforeLoad` re-fetched the
      // descriptor the user had just produced (D-CAP-041-1 promise:
      // one HTTP GET per navigation, not two).
      queryClient.setQueryData(authQueryKeys.session(), descriptor);
      setAuthSession(descriptor);
    },
  });
}

/**
 * Sign-out mutation. POST /api/v1/auth/better/sign-out — Better Auth
 * clears the cookie via its own `Set-Cookie` response. We then drop the
 * cached descriptor and clear the in-memory store so the next navigation
 * to `/mailbox` redirects to `/login`.
 */
export function useSignOutMutation(): UseMutationResult<void, ApiError, void> {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await apiClient.fetch('/api/v1/auth/better/sign-out', { method: 'POST' });
    },
    onSuccess: async () => {
      // Same rationale as `useSignInMutation.onSuccess` (CAP-042
      // Batch 8 M-2): `setQueryData` is sufficient. `invalidateQueries`
      // would force a fresh GET on the next navigation when we already
      // know the user is signed out.
      queryClient.setQueryData(authQueryKeys.session(), null);
      clearAuthSession();
    },
  });
}

/**
 * Registration input. The application registration endpoint
 * (POST /api/v1/auth/register) is the *only* user-creation surface;
 * Better Auth's `sign-up/email` is disabled at the framework level
 * (CAP-042 ADR-008 / R-AUTH-006). Registration consumes one of the
 * invite codes an admin issues via POST /api/v1/admin/invite-codes
 * (R-AUTH-008 / R-AUTH-008: email-prefix limit enforced server-side).
 */
export interface AuthRegisterInput {
  readonly code: string;
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

export interface AuthRegisterResult {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
}

export function useRegisterMutation(): UseMutationResult<
  AuthRegisterResult,
  ApiError,
  AuthRegisterInput
> {
  const apiClient = useApiClient();
  return useMutation({
    mutationFn: async (input: AuthRegisterInput): Promise<AuthRegisterResult> => {
      const response = await apiClient.fetch<{
        readonly data: { readonly user: AuthRegisterResult };
      }>('/api/v1/auth/register', { method: 'POST', body: input });
      return response.data.user;
    },
  });
}
