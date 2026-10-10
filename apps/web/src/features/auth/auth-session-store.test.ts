// apps/web — auth session store test.
//
// CAP-042 (Batch 5) AC 21: the auth session descriptor is NEVER written
// to localStorage, sessionStorage, or IndexedDB. No `persist`
// middleware. This file's companion, `auth-session-storage.test.ts`,
// enforces the same invariant across the whole `features/auth/**` tree
// via a structural walk.
//
// This unit test covers the *behaviour* of the store itself — the
// initial state, the setter, the clearer, and the test-only reset helper.
import { describe, expect, it, beforeEach } from 'vitest';
import {
  useAuthSession,
  setAuthSession,
  clearAuthSession,
  resetAuthSessionForTesting,
  type AuthSessionDescriptor,
} from './auth-session-store';

const FIXTURE: AuthSessionDescriptor = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'auth-store@example.test',
  displayName: 'Auth Store',
  expiresAt: '2099-01-01T00:00:00Z',
};

describe('auth-session-store', () => {
  beforeEach(() => {
    resetAuthSessionForTesting();
  });

  it('starts with a null session descriptor', () => {
    expect(useAuthSession.getState().session).toBeNull();
  });

  it('setAuthSession stores the descriptor in memory', () => {
    setAuthSession(FIXTURE);
    const state = useAuthSession.getState();
    expect(state.session).not.toBeNull();
    expect(state.session?.userId).toBe(FIXTURE.userId);
    expect(state.session?.email).toBe(FIXTURE.email);
    expect(state.session?.displayName).toBe(FIXTURE.displayName);
    expect(state.session?.expiresAt).toBe(FIXTURE.expiresAt);
  });

  it('clearAuthSession removes the descriptor', () => {
    setAuthSession(FIXTURE);
    clearAuthSession();
    expect(useAuthSession.getState().session).toBeNull();
  });

  it('resetAuthSessionForTesting returns to the initial state', () => {
    setAuthSession(FIXTURE);
    resetAuthSessionForTesting();
    expect(useAuthSession.getState().session).toBeNull();
  });

  it('useAuthSession is a Zustand store with callable getState/setState', () => {
    setAuthSession(FIXTURE);
    // We assert the *store surface* without invoking the React hook
    // (Zustand 5's hook requires a React renderer context — calling it
    // outside `<render>` throws `useSyncExternalStore is not defined`
    // under happy-dom). `getState` / `setState` are the imperative
    // hooks used by `setAuthSession` / `clearAuthSession`; their
    // existence proves the underlying store is a real Zustand store.
    const observed = useAuthSession.getState();
    expect(observed.session?.userId).toBe(FIXTURE.userId);
    useAuthSession.setState({ session: null });
    expect(useAuthSession.getState().session).toBeNull();
  });
});
