// modules/identity — owner of users, sessions, idempotency_records.
// Exports: createUser, prepareCreateUser, getFirstUser, findUserByEmail — user repository functions.
// Exports: createSession, findSessionByRefreshHash, revokeSession, revokeUserSessions — session repository functions.
// The repository (createUser, createSession) is private (D-CAP-006-C).
export { createUser, prepareCreateUser, getFirstUser, findUserByEmail } from './user-repository';
export { createSession, findSessionByRefreshHash, revokeSession, revokeUserSessions } from './session-repository';
export type { CreateUserInput, UserInfo } from './user-repository';
export type { CreateSessionInput, SessionRow } from './session-repository';
