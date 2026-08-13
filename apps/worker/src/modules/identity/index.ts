// modules/identity — owner of users, sessions, idempotency_records.
// Exports: createUser, getFirstUser — user repository functions.
// The repository (createUser) is private (D-CAP-006-C).
export { createUser, prepareCreateUser, getFirstUser } from './user-repository';
export type { CreateUserInput } from './user-repository';
