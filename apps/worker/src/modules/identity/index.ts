// modules/identity — owner of users, sessions, idempotency_records.
// Exports: createUser, prepareCreateUser, getFirstUser, findUserByEmail — user repository functions.
// Exports: listUsers — admin users-list read (CAP-044 Slice 3, AC 15;
//   consumed by the admin route through the allowed admin → identity edge,
//   D-CAP-044-H).
// Exports: createSession, findSessionByRefreshHash, revokeSession, revokeUserSessions — session repository functions.
// Exports: prepareCreateCredential, encodeCredentialEnvelope, credentialIdFor — credential helpers (CAP-042 Batch 4 atomic registration).
// The repository (createUser, createSession) is private (D-CAP-006-C).
export { createUser, prepareCreateUser, getFirstUser, findUserByEmail } from './user-repository';
export { listUsers, UserCursorInvalidError, UserRowInvalidError } from './user-list-repository';
export {
  findActiveUserByEmail,
  findActiveUserById,
  findActiveUsersByIds,
} from './user-summary-repository';
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
export type { UserListResult } from './user-list-repository';
export type { PublicUserSummary } from './user-summary-repository';
export type { CreateSessionInput, SessionRow } from './session-repository';
export type { CreateCredentialInput } from './credential-repository';
