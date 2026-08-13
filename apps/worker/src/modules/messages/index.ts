// modules/messages — owner of messages, message_recipients, mailbox_messages, message_user_state.
// Exports: message repository functions for creating messages and associations.
// The repository is the public surface; private implementation is in message-repository.ts.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// R-MESSAGE-005: isRead persists per user (message-read-repository).

export {
  prepareCreateMessage,
  prepareCreateRecipient,
  prepareCreateMailboxMessage,
  createMessageWithRelations,
} from './message-repository';
export type { CreateMessageInput, CreateRecipientInput, CreateMailboxMessageInput } from './message-repository';

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
