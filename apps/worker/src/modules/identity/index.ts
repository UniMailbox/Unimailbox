// modules/identity — owner of users, sessions, idempotency_records.
// Exports: createUser — inserts a user row.
// The repository (createUser) is private (D-CAP-006-C).
export { createUser, prepareCreateUser } from './user-repository';
export type { CreateUserInput } from './user-repository';
