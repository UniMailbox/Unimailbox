/** Safe request-local identity projection; never contains password/session secrets. */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly mustChangePassword: boolean;
}
