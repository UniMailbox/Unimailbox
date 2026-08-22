// apps/web — setup session token store.
//
// CAP-041 / R-SECRET-003: the setup session token is sensitive — equivalent
// to the deploy-time INSTALLATION_TOKEN. It lives in memory only: NO
// `localStorage`, NO `sessionStorage`, NO `IndexedDB`, NO `persist` middleware.
// A hard reload discards the token and the operator restarts at /setup/claim —
// the wizard's resumability is server-driven (the server's `currentStep`),
// not client-state (this store).
//
// Usage:
//   - Read: `const token = useSetupSession((s) => s.sessionToken);`
//   - Write after /claim: `setSetupSession(token);`
//   - Clear: `clearSetupSession();`
//
// The store is a vanilla Zustand store, deliberately minimal. There is no
// event-bus usage; the API client reads the token via a getter passed at
// construction time so the client never imports this module.
import { create } from 'zustand';

export interface SetupSessionState {
  readonly sessionToken: string | null;
}

export interface SetupSessionActions {
  readonly setSetupSession: (token: string) => void;
  readonly clearSetupSession: () => void;
}

export type SetupSessionStore = SetupSessionState & SetupSessionActions;

const initialState: SetupSessionState = { sessionToken: null };

export const useSetupSession = create<SetupSessionStore>((set) => ({
  ...initialState,
  setSetupSession: (token) => set({ sessionToken: token }),
  clearSetupSession: () => set({ sessionToken: null }),
}));

export function setSetupSession(token: string): void {
  useSetupSession.getState().setSetupSession(token);
}

export function clearSetupSession(): void {
  useSetupSession.getState().clearSetupSession();
}

/** Test helper — resets the store to its initial state. Not exported outside
 * the test setup. */
export function resetSetupSessionForTesting(): void {
  useSetupSession.setState({ sessionToken: null });
}
