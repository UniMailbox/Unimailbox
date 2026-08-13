// modules/tenancy — owner of managed_domains, mailboxes, mailbox_members.
// Exports: createDomain, prepareCreateDomain — the domain repository.
// The repository is private (D-CAP-006-C).
export { createDomain, prepareCreateDomain } from './domain-repository';
export type { CreateDomainInput } from './domain-repository';
