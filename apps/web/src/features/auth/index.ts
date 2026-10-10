// apps/web — auth feature public API.
//
// The router and tests import from here. Components and queries stay
// private unless re-exported below; the public surface is the smallest
// set needed to wire the auth shell.
export { LoginPage } from './LoginPage';
export { RegisterPage } from './RegisterPage';
export { LogoutButton } from './LogoutButton';
export { Unauthorized } from './Unauthorized';
export { AuthErrorBoundary } from './AuthErrorBoundary';
export type { UnauthorizedProps } from './Unauthorized';

export {
  useAuthSession,
  setAuthSession,
  clearAuthSession,
  resetAuthSessionForTesting,
} from './auth-session-store';
export type { AuthSessionDescriptor, AuthSessionStore } from './auth-session-store';

export {
  authQueryKeys,
  authSessionQuery,
  fetchAuthSession,
  parseSessionResponse,
  useSignInMutation,
  useSignOutMutation,
  useRegisterMutation,
} from './auth-queries';
export type { AuthSignInInput, AuthRegisterInput, AuthRegisterResult } from './auth-queries';
