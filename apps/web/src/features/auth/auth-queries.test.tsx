// Tests for the application-owned D1 session contract.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  parseSessionResponse,
  fetchAuthSession,
  authQueryKeys,
  useSignInMutation,
  useChangePasswordMutation,
  authSessionQuery,
  useSignOutMutation,
} from './auth-queries';
import { ApiError } from '../../infrastructure/api/errors';
import type { ApiClient } from '../../infrastructure/api/client';
import { renderHook, act, waitFor } from '@testing-library/react';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import type { ReactElement, ReactNode } from 'react';
import { useAuthSession, setAuthSession, resetAuthSessionForTesting } from './auth-session-store';

const VALID_USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_EMAIL = 'auth-queries@example.test';
const VALID_DISPLAY_NAME = 'Auth Queries';

describe('parseSessionResponse', () => {
  it('returns null for invalid or missing application envelopes', () => {
    expect(parseSessionResponse(null)).toBeNull();
    expect(parseSessionResponse(undefined)).toBeNull();
    expect(parseSessionResponse({ data: null })).toBeNull();
    expect(parseSessionResponse({ data: { user: null } })).toBeNull();
    expect(parseSessionResponse('not-a-session')).toBeNull();
  });

  it('parses the /auth/me response and normalizes optional fields', () => {
    const descriptor = parseSessionResponse({
      data: {
        user: { id: VALID_USER_ID, email: VALID_EMAIL, displayName: VALID_DISPLAY_NAME },
        mustChangePassword: false,
        canAccessAdmin: true,
      },
    });
    expect(descriptor).toEqual({
      userId: VALID_USER_ID,
      email: VALID_EMAIL,
      displayName: VALID_DISPLAY_NAME,
      expiresAt: '',
      mustChangePassword: false,
      canAccessAdmin: true,
    });
  });

  it('uses null for a missing display name and preserves the password-change gate', () => {
    const descriptor = parseSessionResponse({
      data: {
        user: { id: VALID_USER_ID, email: VALID_EMAIL },
        mustChangePassword: true,
      },
    });
    expect(descriptor?.displayName).toBeNull();
    expect(descriptor?.mustChangePassword).toBe(true);
  });

  it('rejects a user without string id or email', () => {
    expect(parseSessionResponse({ data: { user: { id: 42, email: VALID_EMAIL } } })).toBeNull();
    expect(parseSessionResponse({ data: { user: { id: VALID_USER_ID, email: 42 } } })).toBeNull();
  });
});

describe('fetchAuthSession', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAuthSessionForTesting();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the parsed descriptor from /auth/me', async () => {
    const apiClient = makeClient(
      jsonResponse({
        data: {
          user: { id: VALID_USER_ID, email: VALID_EMAIL, displayName: VALID_DISPLAY_NAME },
          mustChangePassword: false,
        },
      }),
    );
    await expect(fetchAuthSession(apiClient)).resolves.toMatchObject({ userId: VALID_USER_ID });
  });

  it('returns null when the access token and refresh cookie are both invalid', async () => {
    await expect(
      fetchAuthSession(
        makeClient(
          errorResponse('AUTHENTICATION_REQUIRED', 'Required', 401),
          errorResponse('REFRESH_TOKEN_INVALID', 'Invalid', 401),
        ),
      ),
    ).resolves.toBeNull();
  });

  it('returns null when the browser has no refresh cookie', async () => {
    await expect(
      fetchAuthSession(
        makeClient(
          errorResponse('AUTHENTICATION_REQUIRED', 'Required', 401),
          errorResponse('REFRESH_TOKEN_REQUIRED', 'Refresh token required', 401),
        ),
      ),
    ).resolves.toBeNull();
  });

  it('rethrows non-authentication failures', async () => {
    await expect(
      fetchAuthSession(makeClient(errorResponse('INTERNAL', 'Database unreachable', 500))),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('recovers a hard reload with the HttpOnly-cookie refresh endpoint', async () => {
    const calls: string[] = [];
    let currentAccessToken: string | null = null;
    const apiClient: ApiClient = {
      baseUrl: '',
      async fetch<T>(path: string): Promise<T> {
        calls.push(path);
        currentAccessToken = useAuthSession.getState().accessToken;
        if (path.endsWith('/me') && currentAccessToken === null) {
          throw new ApiError('AUTHENTICATION_REQUIRED', 'Required', 401);
        }
        if (path.endsWith('/refresh')) {
          return { data: { accessToken: 'recovered-access-token' } } as T;
        }
        return {
          data: {
            user: { id: VALID_USER_ID, email: VALID_EMAIL, displayName: VALID_DISPLAY_NAME },
            mustChangePassword: false,
          },
        } as T;
      },
    };
    await expect(fetchAuthSession(apiClient)).resolves.toMatchObject({ userId: VALID_USER_ID });
    expect(calls).toEqual(['/api/v1/auth/me', '/api/v1/auth/refresh', '/api/v1/auth/me']);
    expect(currentAccessToken).toBe('recovered-access-token');
    expect(useAuthSession.getState().session?.userId).toBe(VALID_USER_ID);
  });

  it('drops the refreshed token if the follow-up identity check fails', async () => {
    const apiClient: ApiClient = {
      baseUrl: '',
      async fetch<T>(path: string): Promise<T> {
        if (path.endsWith('/refresh')) {
          return { data: { accessToken: 'unverified-access-token' } } as T;
        }
        throw new ApiError('AUTHENTICATION_REQUIRED', 'Required', 401);
      },
    };
    await expect(fetchAuthSession(apiClient)).resolves.toBeNull();
    expect(useAuthSession.getState().accessToken).toBeNull();
  });
});

function makeClient(...responses: Response[]): ApiClient {
  let index = 0;
  return {
    baseUrl: '',
    async fetch<T>(): Promise<T> {
      const response = responses[Math.min(index++, responses.length - 1)];
      if (response === undefined) throw new Error('test response queue is empty');
      if (response.status === 204) return undefined as T;
      if (!response.ok) {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        throw new ApiError(
          body.error?.code ?? 'HTTP_ERROR',
          body.error?.message ?? 'Request failed',
          response.status,
        );
      }
      return (await response.json()) as T;
    },
  };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('R-AUTHZ-002 bounded UI identity reuse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAuthSessionForTesting();
  });

  it('shares a recent identity across panel mounts, then rechecks a stale identity', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const apiClient = makeClient(
      jsonResponse({
        data: { user: { id: VALID_USER_ID, email: VALID_EMAIL }, canAccessAdmin: true },
      }),
      jsonResponse({
        data: { user: { id: VALID_USER_ID, email: VALID_EMAIL }, canAccessAdmin: false },
      }),
    );
    const fetch = vi.spyOn(apiClient, 'fetch');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    function Wrapper({ children }: { children: ReactNode }): ReactElement {
      return (
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={apiClient}>{children}</ApiClientProvider>
        </QueryClientProvider>
      );
    }
    const page = renderHook(() => authSessionQuery(), { wrapper: Wrapper });
    await waitFor(() => expect(page.result.current.data?.canAccessAdmin).toBe(true));
    now += 1_000;
    const panel = renderHook(() => authSessionQuery(), { wrapper: Wrapper });
    await waitFor(() => expect(panel.result.current.data?.userId).toBe(VALID_USER_ID));
    panel.unmount();
    const reopened = renderHook(() => authSessionQuery(), { wrapper: Wrapper });
    await waitFor(() => expect(reopened.result.current.data?.userId).toBe(VALID_USER_ID));
    expect(fetch).toHaveBeenCalledTimes(1);
    reopened.unmount();
    now += 60_000;
    const stale = renderHook(() => authSessionQuery(), { wrapper: Wrapper });
    await waitFor(() => expect(stale.result.current.data?.canAccessAdmin).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(page.result.current.data?.canAccessAdmin).toBe(false);
    page.unmount();
    stale.unmount();
    queryClient.clear();
  });

  it('explicit invalidation and sign-out update observers without waiting for freshness expiry', async () => {
    const apiClient = makeClient(
      jsonResponse({
        data: { user: { id: VALID_USER_ID, email: VALID_EMAIL }, canAccessAdmin: true },
      }),
      jsonResponse({
        data: { user: { id: VALID_USER_ID, email: VALID_EMAIL }, canAccessAdmin: false },
      }),
      new Response(null, { status: 204 }),
    );
    const fetch = vi.spyOn(apiClient, 'fetch');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    function Wrapper({ children }: { children: ReactNode }): ReactElement {
      return (
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={apiClient}>{children}</ApiClientProvider>
        </QueryClientProvider>
      );
    }
    const page = renderHook(
      () => ({ session: authSessionQuery(), signOut: useSignOutMutation() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(page.result.current.session.data?.canAccessAdmin).toBe(true));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: authQueryKeys.session() });
    });
    await waitFor(() => expect(page.result.current.session.data?.canAccessAdmin).toBe(false));
    await act(async () => {
      await page.result.current.signOut.mutateAsync();
    });
    await waitFor(() => expect(page.result.current.session.data).toBeNull());
    expect(fetch).toHaveBeenCalledTimes(3);
    page.unmount();
    queryClient.clear();
  });
});

describe('useSignInMutation cache write', () => {
  it('writes the login response into the session cache without a refetch', async () => {
    const apiClient: ApiClient = {
      baseUrl: '',
      async fetch<T>(): Promise<T> {
        return (await jsonResponse({
          data: {
            accessToken: 'access-token-test',
            user: { id: VALID_USER_ID, email: VALID_EMAIL, displayName: VALID_DISPLAY_NAME },
            mustChangePassword: false,
          },
        }).json()) as T;
      },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    function Wrapper({ children }: { children: ReactNode }): ReactElement {
      return (
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={apiClient}>{children}</ApiClientProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useSignInMutation(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ email: VALID_EMAIL, password: 'secret123' });
    });
    expect(queryClient.getQueryData(authQueryKeys.session())).toMatchObject({
      userId: VALID_USER_ID,
      email: VALID_EMAIL,
      mustChangePassword: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('useChangePasswordMutation session update', () => {
  it('keeps the in-memory access token after the first password change', async () => {
    resetAuthSessionForTesting();
    const descriptor = {
      userId: VALID_USER_ID,
      email: VALID_EMAIL,
      displayName: VALID_DISPLAY_NAME,
      expiresAt: '',
      mustChangePassword: true,
    };
    setAuthSession({ ...descriptor, accessToken: 'first-login-token' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(authQueryKeys.session(), descriptor);
    const apiClient: ApiClient = {
      baseUrl: '',
      async fetch<T>(): Promise<T> {
        return undefined as T;
      },
    };
    function Wrapper({ children }: { children: ReactNode }): ReactElement {
      return (
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={apiClient}>{children}</ApiClientProvider>
        </QueryClientProvider>
      );
    }
    const { result } = renderHook(() => useChangePasswordMutation(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({ currentPassword: 'old-pass', newPassword: 'new-pass' });
    });
    expect(useAuthSession.getState().accessToken).toBe('first-login-token');
    expect(useAuthSession.getState().session?.mustChangePassword).toBe(false);
  });
});
