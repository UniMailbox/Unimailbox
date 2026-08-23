// apps/web — auth session descriptor store.
//
// CAP-042 (Batch 5) / R-SECRET-003: the browser never holds an access,
// refresh, or session token. The Better Auth cookie (`unimailbox.session_token`)
// is HttpOnly — the JavaScript runtime cannot read it. This store carries
// only the *descriptor* the UI needs: who is signed in and what they are
// called. The cookie is set automatically by Better Auth's sign-in
// response and sent automatically with every `credentials: 'include'`
// fetch (the existing `ApiClient` already does this through the browser's
// default `fetch` behavior — see `infrastructure/api/client.ts`).
//
// AC 21: this file MUST NOT import or reference `localStorage`,
// `sessionStorage`, or `indexedDB`. A reviewer should be able to read the
// source and see no `persist` middleware. `auth-session-storage.test.ts`
// enforces the same invariant across the whole `features/auth/**` tree.
//
// A hard reload discards the descriptor. The user is not forcibly signed
// out — the cookie persists — but the UI is unaware of them until
// `authSessionQuery` re-fetches via the cookie. That is the
// cache-backed-router path (D-CAP-041-1): the `/mailbox` `beforeLoad`
// calls `queryClient.ensureQueryData({ queryKey: authQueryKeys.session() })`
// so the next mount repopulates the descriptor from a single GET.
import { create } from 'zustand';

/**
 * AuthSessionDescriptor — the non-secret summary of the signed-in user.
 * Mirrors the union of the canonical `users` row and the Better Auth
 * `auth_sessions` row. We never store a token here; the only thing that
 * can prove identity is the HttpOnly cookie the browser holds.
 *
 * Better Auth's response shape is owned by the framework and confined
 * to this auth boundary (per CAP-042 ADR-008 / spike-evidence.md).
 * `parseSessionResponse` in `auth-queries.ts` is the single parser that
 * narrows `unknown` into this typed descriptor.
 */
export interface AuthSessionDescriptor {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly expiresAt: string;
}

export interface AuthSessionState {
  readonly session: AuthSessionDescriptor | null;
}

export interface AuthSessionActions {
  readonly setAuthSession: (session: AuthSessionDescriptor) => void;
  readonly clearAuthSession: () => void;
}

export type AuthSessionStore = AuthSessionState & AuthSessionActions;

const initialState: AuthSessionState = { session: null };

export const useAuthSession = create<AuthSessionStore>((set) => ({
  ...initialState,
  setAuthSession: (session) => set({ session }),
  clearAuthSession: () => set({ session: null }),
}));

export function setAuthSession(session: AuthSessionDescriptor): void {
  useAuthSession.getState().setAuthSession(session);
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
  useAuthSession.setState({ session: null });
}