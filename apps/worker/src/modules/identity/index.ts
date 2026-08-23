// modules/identity — owner of users, sessions, idempotency_records.
// Exports: createUser, prepareCreateUser, getFirstUser, findUserByEmail — user repository functions.
// Exports: createSession, findSessionByRefreshHash, revokeSession, revokeUserSessions — session repository functions.
// Exports: prepareCreateCredential, encodeCredentialEnvelope, credentialIdFor — credential helpers (CAP-042 Batch 4 atomic registration).
// The repository (createUser, createSession) is private (D-CAP-006-C).
export { createUser, prepareCreateUser, getFirstUser, findUserByEmail } from './user-repository';
export {
  createSession,
  findSessionByRefreshHash,
  revokeSession,
  revokeUserSessions,
} from './session-repository';
export {
  prepareCreateCredential,
  encodeCredentialEnvelope,
  credentialIdFor,
} from './credential-repository';
export type { CreateUserInput, UserInfo } from './user-repository';
export type { CreateSessionInput, SessionRow } from './session-repository';
export type { CreateCredentialInput } from './credential-repository';
