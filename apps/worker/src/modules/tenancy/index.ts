// modules/tenancy — owner of managed_domains, mailboxes, mailbox_members.
// Exports: createDomain, prepareCreateDomain, getManagedDomain — the domain repository.
// The repository is private (D-CAP-006-C).
export { createDomain, prepareCreateDomain, getManagedDomain } from './domain-repository';
export type { CreateDomainInput, ManagedDomainInfo } from './domain-repository';
