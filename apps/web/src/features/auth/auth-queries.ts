// Application-owned authentication queries.
// The Worker issues a short-lived access token from /auth/login. The token is
// held only in the in-memory auth store; protected calls use ApiClient's
// Authorization header and D1 remains the session authority.

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
import {
  type AuthSessionDescriptor,
  setAuthSession,
  setAccessToken,
  clearAuthSession,
  useAuthSession,
} from './auth-session-store';

export const authQueryKeys = {
  all: ['auth'] as const,
  session: () => [...authQueryKeys.all, 'session'] as const,
};

export function parseSessionResponse(response: unknown): AuthSessionDescriptor | null {
  if (response === null || typeof response !== 'object') return null;
  const data = (response as { data?: unknown }).data;
  if (data === null || typeof data !== 'object') return null;
  const body = data as {
    user?: { id?: unknown; email?: unknown; displayName?: unknown };
    mustChangePassword?: unknown;
    canAccessAdmin?: unknown;
  };
  if (!body.user || typeof body.user.id !== 'string' || typeof body.user.email !== 'string')
    return null;
  return {
    userId: body.user.id,
    email: body.user.email,
    displayName: typeof body.user.displayName === 'string' ? body.user.displayName : null,
    expiresAt: '',
    mustChangePassword: body.mustChangePassword === true,
    ...(typeof body.canAccessAdmin === 'boolean' && { canAccessAdmin: body.canAccessAdmin }),
  };
}

export async function fetchAuthSession(
  apiClient: ApiClient,
): Promise<AuthSessionDescriptor | null> {
  try {
    return parseSessionResponse(await apiClient.fetch<unknown>('/api/v1/auth/me'));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;

    // A hard reload clears the in-memory access token. The refresh token is
    // carried by the HttpOnly cookie set by the Worker, so recovery does not
    // expose a credential to JavaScript or browser storage. The empty JSON
    // object keeps the legacy body contract valid while the Worker fills in
    // the token from the cookie.
    try {
      const refreshed = await apiClient.fetch<{ data?: { accessToken?: unknown } }>(
        '/api/v1/auth/refresh',
        { method: 'POST', body: {} },
      );
      const accessToken = refreshed.data?.accessToken;
      if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
      // The API client reads its Bearer token from the live in-memory store.
      // Install the refreshed token before the second /me request, then keep
      // the verified user descriptor only after that request succeeds.
      setAccessToken(accessToken);
      const descriptor = parseSessionResponse(await apiClient.fetch<unknown>('/api/v1/auth/me'));
      if (descriptor !== null) {
        setAuthSession({ ...descriptor, accessToken });
      } else {
        clearAuthSession();
      }
      return descriptor;
    } catch (refreshError) {
      clearAuthSession();
      // Authentication decisions depend only on codes/status, never translated prose.
      if (refreshError instanceof ApiError && refreshError.status === 401) return null;
      throw refreshError;
    }
  }
}

export function authSessionQuery(): UseQueryResult<AuthSessionDescriptor | null, ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: authQueryKeys.session(),
    queryFn: () => fetchAuthSession(apiClient),
    // Many page/query consumers mount this same descriptor. Reuse a recent
    // success instead of billing an auth KV read for each new observer.
    // This UI snapshot is not authority: protected APIs still check D1 on
    // every request, and mutations explicitly update/invalidate this query.
    staleTime: 60_000,
  });
}

export interface AuthSignInInput {
  readonly email: string;
  readonly password: string;
}

interface LoginResponse {
  readonly data: {
    readonly accessToken: string;
    readonly user: {
      readonly id: string;
      readonly email: string;
      readonly displayName: string | null;
    };
    readonly mustChangePassword?: boolean;
    readonly canAccessAdmin?: boolean;
  };
}

export function useSignInMutation(): UseMutationResult<
  AuthSessionDescriptor,
  ApiError,
  AuthSignInInput
> {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input): Promise<AuthSessionDescriptor> => {
      const response = await apiClient.fetch<LoginResponse>('/api/v1/auth/login', {
        method: 'POST',
        body: input,
      });
      return {
        userId: response.data.user.id,
        email: response.data.user.email,
        displayName: response.data.user.displayName,
        expiresAt: '',
        mustChangePassword: response.data.mustChangePassword === true,
        ...(typeof response.data.canAccessAdmin === 'boolean' && {
          canAccessAdmin: response.data.canAccessAdmin,
        }),
        accessToken: response.data.accessToken,
      };
    },
    onSuccess: (descriptor) => {
      setAuthSession(descriptor);
      queryClient.setQueryData(authQueryKeys.session(), { ...descriptor, accessToken: undefined });
    },
  });
}

export function useSignOutMutation(): UseMutationResult<void, ApiError, void> {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await apiClient.fetch('/api/v1/auth/logout', { method: 'POST' });
    },
    onSuccess: () => {
      clearAuthSession();
      queryClient.setQueryData(authQueryKeys.session(), null);
    },
  });
}

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

/** Compatibility call retained so old clients receive REGISTRATION_DISABLED. */
export function useRegisterMutation(): UseMutationResult<
  AuthRegisterResult,
  ApiError,
  AuthRegisterInput
> {
  const apiClient = useApiClient();
  return useMutation({
    mutationFn: async (input) => {
      const response = await apiClient.fetch<{
        readonly data: { readonly user: AuthRegisterResult };
      }>('/api/v1/auth/register', {
        method: 'POST',
        body: input,
      });
      return response.data.user;
    },
  });
}

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export function useChangePasswordMutation(): UseMutationResult<
  void,
  ApiError,
  ChangePasswordInput
> {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => {
      await apiClient.fetch('/api/v1/auth/change-password', { method: 'POST', body: input });
    },
    onSuccess: () => {
      const current = queryClient.getQueryData<AuthSessionDescriptor | null>(
        authQueryKeys.session(),
      );
      if (current) {
        const updated = { ...current, mustChangePassword: false };
        const accessToken = useAuthSession.getState().accessToken;
        setAuthSession({ ...updated, ...(accessToken !== null && { accessToken }) });
        queryClient.setQueryData(authQueryKeys.session(), { ...updated, accessToken: undefined });
      }
    },
  });
}
