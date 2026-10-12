// modules/tenancy — owner of managed_domains, mailboxes, mailbox_members.
// Exports: domain repository, mailbox repository, assertCan authorizer.
// The repositories are private (D-CAP-006-C).
export {
  createDomain,
  prepareCreateDomain,
  getManagedDomain,
  listManagedDomains,
  findManagedDomainById,
  countMailboxesForDomain,
  prepareDeleteDomain,
  prepareRequireManagedDomainDeleted,
  prepareUpdateDomainOutboundConnection,
  prepareRequireManagedDomainUpdated,
} from './domain-repository';
export type { CreateDomainInput, ManagedDomainInfo } from './domain-repository';

export {
  createMailbox,
  findMailboxById,
  findMailboxByAddress,
  resolveInboundMailbox,
  listMailboxesByUser,
  findMailboxMember,
  listMailboxMemberRows,
  prepareCreateMailboxMember,
  prepareDeleteMailboxMember,
  prepareRequireMailboxMemberDeleted,
} from './mailbox-repository';
export type {
  CreateMailboxInput,
  MailboxInfo,
  MailboxMemberInfo,
  MailboxMemberRow,
  CreateMailboxMemberInput,
} from './mailbox-repository';

export { assertCan, type MailboxOp } from './authorizer';
export {
  assertCanManageMailboxMembers,
  addMailboxMember,
  listMailboxMembers,
  removeMailboxMember,
  mailboxMemberOperation,
  type AddMailboxMemberInput,
  type ListMailboxMembersInput,
  type RemoveMailboxMemberInput,
  type MailboxMemberServiceDependencies,
  type MailboxMemberServiceResult,
} from './mailbox-member-service';
