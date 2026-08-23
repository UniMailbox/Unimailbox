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
  // CAP-043 Slice 2 / AC 9: same-thread messages for one mailbox,
  // oldest-first, root resolved at read time (D-CAP-043-C).
  getMessageThread,
  markMessageAsRead,
  // CAP-043 Slice 1 / R-API-005: the typed CursorInvalidError so the
  // route layer can map a tampered cursor to 400 INVALID_CURSOR without
  // reaching into platform/cursor.ts. signCursor / verifyCursor are
  // consumed by the repository directly (fix pass F8 removed the
  // encodeCursor alias — it had no callers).
  CursorInvalidError,
} from './message-read-repository';
export type {
  MessageListItem,
  MessageDetail,
  MessageThread,
  RecipientInfo,
  ListMessagesResult,
} from './message-read-repository';
