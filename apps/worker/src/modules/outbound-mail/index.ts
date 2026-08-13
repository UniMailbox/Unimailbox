// apps/worker/src/modules/outbound-mail/index.ts — CAP-014.
// Public API for the outbound-mail module. Exports the repository
// functions and their input types.
//
// Per .claude/rules/architecture.md: a module's index.ts is its entire
// public API; everything else is private.

export {
  prepareCreateCredential,
  type CreateCredentialInput,
} from './credential-repository';

export {
  prepareCreateConnection,
  type CreateConnectionInput,
} from './connection-repository';