// modules/tenancy — owner of managed_domains, mailboxes, mailbox_members.
// Exports: domain repository, mailbox repository, assertCan authorizer.
// The repositories are private (D-CAP-006-C).
export { createDomain, prepareCreateDomain, getManagedDomain } from './domain-repository';
export type { CreateDomainInput, ManagedDomainInfo } from './domain-repository';

export {
  createMailbox,
  findMailboxById,
  findMailboxByAddress,
  listMailboxesByUser,
  listMailboxesByOwner,
  findMailboxMember,
} from './mailbox-repository';
export type { CreateMailboxInput, MailboxInfo, MailboxMemberInfo } from './mailbox-repository';

export { assertCan, type MailboxOp } from './authorizer';
