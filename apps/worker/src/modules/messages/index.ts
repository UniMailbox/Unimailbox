// modules/messages — owner of messages, message_recipients, mailbox_messages, message_user_state.
// Exports: message repository functions for creating messages and associations.
// The repository is the public surface; private implementation is in message-repository.ts.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// R-MESSAGE-005: isRead persists per user (message-read-repository).
// R-MESSAGE-007: webhook status updates apply iff newer (or equal+higher-rank).
//   The single `messages` row writer is updateMessageStatus — outbound-mail
//   must use it (D-CAP-028-D).

export {
  prepareCreateMessage,
  prepareCreateRecipient,
  prepareCreateMailboxMessage,
  createMessageWithRelations,
  updateMessageStatus,
  // CAP-040 / D-CAP-029-A: callers batching messages UPDATE into a
  // db.batch([...]) use this to fold the row write into the same
  // transaction as their audit / delivery rows.
  prepareUpdateMessageStatus,
} from './message-repository';
export type {
  CreateMessageInput,
  CreateRecipientInput,
  CreateMailboxMessageInput,
  UpdateMessageStatusInput,
} from './message-repository';

export {
  listMessagesByMailbox,
  getMessageDetail,
  markMessageAsRead,
} from './message-read-repository';
export type {
  MessageListItem,
  MessageDetail,
  RecipientInfo,
  ListMessagesResult,
} from './message-read-repository';
