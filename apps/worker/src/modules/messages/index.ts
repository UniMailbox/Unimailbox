// modules/messages — owner of messages, message_recipients, mailbox_messages, message_user_state.
// Exports: message repository functions for creating messages and associations.
// The repository is the public surface; private implementation is in message-repository.ts.
//
// R-INBOUND-008: Message + recipients + mailbox_messages inserted in one D1 batch
// R-MESSAGE-005: isRead and isStarred persist per user (message-read-repository).
// R-MESSAGE-007: webhook status updates apply iff newer (or equal+higher-rank).
//   The single `messages` row writer is updateMessageStatus — outbound-mail
//   must use it (D-CAP-028-D).

export {
  prepareCreateMessage,
  prepareCreateRecipient,
  prepareCreateMailboxMessage,
  createMessageWithRelations,
  // CAP-047: typed prepared writer for the draft→queued send-side transition.
  // The route folds this UPDATE into the same D1 batch as the outbound_jobs
  // INSERT and the idempotency record (one-atomic-send).
  prepareQueueDraftForSend,
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
  QueueDraftForSendInput,
  UpdateMessageStatusInput,
} from './message-repository';

export {
  listMessagesByMailbox,
  getMessageDetail,
  // CAP-043 Slice 2 / AC 9: same-thread messages for one mailbox,
  // oldest-first, root resolved at read time (D-CAP-043-C).
  getMessageThread,
  // CAP-043 Slice 3 fix H6: resolves the mailbox_message row from
  // (mailboxId, messageId) itself — the route layer no longer runs raw SQL.
  // Returns false (→ 404 MESSAGE_NOT_FOUND) when the pair has no row.
  markMessageAsRead,
  // CAP-058 / R-MESSAGE-005: read + prepared-write pair so the route folds
  // the per-user star UPSERT into the same D1 batch as the idempotency record
  // and audit row. getMessageStarState returns null
  // (→ 404 MESSAGE_NOT_FOUND) when the pair has no row.
  getMessageStarState,
  prepareSetMessageStar,
  // CAP-043 Slice 3 fix H2 / AC 13 (D-CAP-043-B): builds the per-user
  // soft-delete UPSERT for the route's atomic batch. Returns null
  // (→ 404 MESSAGE_NOT_FOUND) when the pair has no row.
  prepareSoftDeleteMessageForUser,
  // CAP-043 Slice 1 / R-API-005: the typed CursorInvalidError so the
  // route layer can map a tampered cursor to 400 INVALID_CURSOR without
  // reaching into platform/cursor.ts. signCursor / verifyCursor are
  // consumed by the repository directly (fix pass F8 removed the
  // encodeCursor alias — it had no callers).
  CursorInvalidError,
} from './message-read-repository';

export {
  findAttachmentUploadCommitState,
  prepareCreateAttachmentUpload,
} from './attachment-upload-repository';
export type {
  AttachmentUploadCommitState,
  AttachmentUploadCommitStateInput,
  CreateAttachmentUploadInput,
} from './attachment-upload-repository';

// CAP-050 — messages-owned attachment-consume surface. The compose route
// preflights each upload through `listAttachmentUploadsForConsume`, then
// folds the resulting prepareCreateMessageAttachment /
// prepareConsumeAttachmentUpload statements into the same D1 batch as
// the message INSERT. `listMessageAttachmentsForSend` is the read-only
// projection the outbound-mail queue consumer uses to rebuild the
// provider-neutral attachment payload (the bytes themselves are pulled
// from CACHE through the `AttachmentByteStore` platform seam, never
// from D1).
export {
  listAttachmentUploadsForConsume,
  prepareCreateMessageAttachment,
  prepareConsumeAttachmentUpload,
  listMessageAttachmentsForSend,
  findMessageAttachmentForDownload,
  listExpiredAttachmentUploads,
  completeAttachmentCleanup,
  prepareExpireAttachmentUpload,
  prepareRequireAttachmentExpiryTransition,
  findAttachmentUploadStatus,
} from './attachment-consume-repository';
export type {
  AttachmentUploadForConsumeRow,
  CreateMessageAttachmentInput,
  ConsumeAttachmentUploadInput,
  ListAttachmentUploadsForConsumeInput,
  ListAttachmentUploadsForConsumeResult,
  MessageAttachmentForSend,
  MessageAttachmentForDownload,
  FindMessageAttachmentForDownloadInput,
  ExpiredAttachmentUpload,
} from './attachment-consume-repository';
export type {
  MessageListItem,
  MessageDetail,
  MessageThread,
  RecipientInfo,
  ListMessagesResult,
} from './message-read-repository';

export {
  prepareCreateInboundAttachment,
  findInboundAttachmentForDownload,
} from './inbound-attachment-repository';
export type { InboundAttachmentInput } from './inbound-attachment-repository';
export { sweepOrphanedInboundObjects, INBOUND_OBJECT_GRACE_MS } from './sweep-inbound-objects';

export {
  prepareRestoreScheduledDraft,
  prepareScheduledMessageSentFolder,
} from './scheduled-message';
export { generateAiReply } from './ai-reply';

export {
  findInboundReceipt,
  findInboundReceiptByKey,
  reserveInboundReceipt,
  claimInboundReceipt,
  prepareCompleteInboundReceipt,
  retryInboundReceipt,
  claimRecoverableInboundReceipts,
  expireCompletedInboundReceipts,
  INBOUND_DEDUP_WINDOW_MS,
  INBOUND_LEASE_MS,
} from './inbound-receipt-repository';
export type { InboundReceipt } from './inbound-receipt-repository';

export { createDraft, readDraft, updateDraft } from './draft-use-cases';
export { markRead, toggleStar, softDeleteMessage } from './change-message-state';
export {
  prepareAuthoredMessage,
  prepareAuthoredMailboxMessage,
  prepareDraftSentFolder,
  resolveAuthorizedMessageMailbox,
} from './authored-message-repository';
