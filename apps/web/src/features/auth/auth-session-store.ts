// apps/web — auth session descriptor store.
//
// The application access token is kept in memory only. It is never written to
// browser storage or a JavaScript-readable cookie. The Worker keeps the
// refresh token in an HttpOnly cookie so a hard reload can recover a session
// without exposing that credential to this store.
//
// AC 21: this file MUST NOT import or reference `localStorage`,
// `sessionStorage`, or `indexedDB`. A reviewer should be able to read the
// source and see no `persist` middleware. `auth-session-storage.test.ts`
// enforces the same invariant across the whole `features/auth/**` tree.
//
// A hard reload discards the descriptor. The `/mailbox` `beforeLoad` calls
// `fetchAuthSession`, which first probes `/me` and then performs one cookie-
// backed refresh when the in-memory access token is absent or expired. The
// recovered descriptor is written back to this memory-only store.
import { create } from 'zustand';

/**
 * AuthSessionDescriptor is the public session summary. `accessToken` is
 * memory-only and is stripped from the descriptor before it is rendered.
 */
export interface AuthSessionDescriptor {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly expiresAt: string;
  readonly mustChangePassword?: boolean;
  readonly canAccessAdmin?: boolean;
  readonly accessToken?: string;
}

export interface AuthSessionState {
  readonly session: AuthSessionDescriptor | null;
  readonly accessToken: string | null;
}

export interface AuthSessionActions {
  readonly setAuthSession: (session: AuthSessionDescriptor) => void;
  readonly setAccessToken: (accessToken: string) => void;
  readonly clearAuthSession: () => void;
}

export type AuthSessionStore = AuthSessionState & AuthSessionActions;

const initialState: AuthSessionState = { session: null, accessToken: null };

export const useAuthSession = create<AuthSessionStore>((set) => ({
  ...initialState,
  setAuthSession: (session) => set({ session, accessToken: session.accessToken ?? null }),
  setAccessToken: (accessToken) => set({ accessToken }),
  clearAuthSession: () => set(initialState),
}));

export function setAuthSession(session: AuthSessionDescriptor): void {
  useAuthSession.getState().setAuthSession(session);
}

export function setAccessToken(accessToken: string): void {
  useAuthSession.getState().setAccessToken(accessToken);
}

export function clearAuthSession(): void {
  useAuthSession.getState().clearAuthSession();
}

/**
 * Test helper — resets the store to its initial state. Not exported
 * outside the test setup; the only consumer is `test-utils.tsx` and the
 * per-feature unit tests.
 */
export function resetAuthSessionForTesting(): void {
  useAuthSession.setState(initialState);
}
