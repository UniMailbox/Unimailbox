// message-read-repository — read-side queries for messages.
// Owner: messages module. Private file — export through modules/messages/index.ts.
//
// R-MESSAGE-005: isRead persists per user. The list and detail queries join
// message_user_state for the requesting user so two members of the same mailbox
// see independent read state. mailbox_messages.is_read is a separate "any-reader"
// flag set by markMessageAsRead for use by unread-count aggregations; the API
// surface reports the per-user value.
// R-AUTHZ-004: Callers must have already asserted access to the mailbox; these
// queries authorise against the supplied mailboxId, never a client-supplied owner.

import type { Database } from '../../platform/database';

export interface RecipientInfo {
  address: string;
  displayName: string;
}

export interface MessageListItem {
  id: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  isRead: number; // 0 or 1 (SQLite integer)
  isStarred: number;
  folder: string;
  createdAt: string;
  recipients: { to: RecipientInfo[]; cc: RecipientInfo[] };
}

export interface MessageDetail {
  id: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  messageIdHeader: string | null;
  inReplyToHeader: string | null;
  referencesHeader: string;
  status: string;
  isRead: number;
  isStarred: number;
  folder: string;
  createdAt: string;
  recipients: { to: RecipientInfo[]; cc: RecipientInfo[] };
}

export interface ListMessagesResult {
  items: MessageListItem[];
  nextCursor: string | null;
}

interface MessageListRow {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  is_starred: number;
  folder: string;
  created_at: string;
  user_is_read: number;
}

interface MessageDetailRow {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  html_body: string;
  text_body: string;
  message_id_header: string | null;
  in_reply_to_header: string | null;
  references_header: string;
  status: string;
  is_starred: number;
  folder: string;
  created_at: string;
  user_is_read: number;
}

interface RecipientRow {
  message_id: string;
  address: string;
  display_name: string;
  type: 'to' | 'cc' | 'bcc';
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

function encodeCursor(payload: CursorPayload): string {
  // Phase 1: base64 of JSON. HMAC signing is CAP-034 (Phase 2).
  return btoa(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const decoded = atob(cursor);
    const parsed = JSON.parse(decoded) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'createdAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as CursorPayload).createdAt === 'string' &&
      typeof (parsed as CursorPayload).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function groupRecipients(rows: RecipientRow[]): {
  to: RecipientInfo[];
  cc: RecipientInfo[];
} {
  const to: RecipientInfo[] = [];
  const cc: RecipientInfo[] = [];
  for (const row of rows) {
    const entry: RecipientInfo = { address: row.address, displayName: row.display_name };
    if (row.type === 'to') {
      to.push(entry);
    } else if (row.type === 'cc') {
      cc.push(entry);
    }
    // bcc recipients are never exposed to readers other than the sender; skip.
  }
  return { to, cc };
}

/**
 * Lists messages in a mailbox, newest first, with cursor pagination.
 *
 * R-MESSAGE-005: isRead is resolved per user via a LEFT JOIN on
 * message_user_state keyed by (mailbox_message_id, user_id). When no row exists
 * for the requesting user the value falls back to 0 (unread).
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access)
 * @param userId — requesting user; drives per-user isRead resolution
 * @param opts — optional cursor + limit
 */
export async function listMessagesByMailbox(
  db: Database,
  mailboxId: string,
  userId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<ListMessagesResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  // Page query: join mailbox_messages → messages, LEFT JOIN per-user state.
  // Cursor slot bound to null when no cursor so the WHERE is a no-op.
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = await db
    .prepare(
      `SELECT m.id, m.from_address, m.from_name, m.subject,
              mm.is_starred, mm.folder, m.created_at,
              COALESCE(mus.is_read, 0) AS user_is_read
         FROM mailbox_messages mm
         JOIN messages m ON mm.message_id = m.id
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND (? IS NULL
               OR (m.created_at < ? OR (m.created_at = ? AND m.id < ?)))
     ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .bind(
      userId,
      mailboxId,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorCreatedAt,
      cursorId,
      limit,
    )
    .all<MessageListRow>();

  const items: MessageListItem[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    isRead: row.user_is_read,
    isStarred: row.is_starred,
    folder: row.folder,
    createdAt: row.created_at,
    recipients: { to: [], cc: [] },
  }));

  // Second query: recipients for the page's message IDs.
  if (items.length > 0) {
    const ids = items.map((i) => i.id);
    const placeholders = ids.map(() => '?').join(',');
    const recipientRows = await db
      .prepare(
        `SELECT message_id, address, display_name, type
           FROM message_recipients
          WHERE message_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<RecipientRow>();

    const byMessage = new Map<string, RecipientRow[]>();
    for (const r of recipientRows.results ?? []) {
      const list = byMessage.get(r.message_id) ?? [];
      list.push(r);
      byMessage.set(r.message_id, list);
    }
    for (const item of items) {
      const list = byMessage.get(item.id);
      if (list) {
        item.recipients = groupRecipients(list);
      }
    }
  }

  // Next cursor: only present when the page was full (more may follow).
  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = encodeCursor({ createdAt: last.createdAt, id: last.id });
    }
  }

  return { items, nextCursor };
}

/**
 * Loads a single message with its recipients, scoped to a mailbox.
 *
 * R-MESSAGE-005: isRead is resolved per user, same strategy as the list query.
 * Returns null when the message is not associated with the given mailbox so
 * the caller can surface a 404 without leaking existence across mailboxes.
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access)
 * @param messageId — target message
 * @param userId — requesting user; drives per-user isRead resolution
 */
export async function getMessageDetail(
  db: Database,
  mailboxId: string,
  messageId: string,
  userId: string,
): Promise<MessageDetail | null> {
  const row = await db
    .prepare(
      `SELECT m.id, m.from_address, m.from_name, m.subject,
              m.html_body, m.text_body,
              m.message_id_header, m.in_reply_to_header, m.references_header,
              m.status, mm.is_starred, mm.folder, m.created_at,
              COALESCE(mus.is_read, 0) AS user_is_read
         FROM mailbox_messages mm
         JOIN messages m ON mm.message_id = m.id
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND mm.message_id = ?`,
    )
    .bind(userId, mailboxId, messageId)
    .first<MessageDetailRow>();

  if (!row) {
    return null;
  }

  const recipientRows = await db
    .prepare(
      `SELECT message_id, address, display_name, type
         FROM message_recipients
        WHERE message_id = ?`,
    )
    .bind(messageId)
    .all<RecipientRow>();

  return {
    id: row.id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    htmlBody: row.html_body,
    textBody: row.text_body,
    messageIdHeader: row.message_id_header,
    inReplyToHeader: row.in_reply_to_header,
    referencesHeader: row.references_header,
    status: row.status,
    isRead: row.user_is_read,
    isStarred: row.is_starred,
    folder: row.folder,
    createdAt: row.created_at,
    recipients: groupRecipients(recipientRows.results ?? []),
  };
}

/**
 * Marks a mailbox_message as read for a specific user.
 *
 * Two writes run in one D1 batch (R-MESSAGE-005):
 *   1. mailbox_messages.is_read = 1 — the "any reader" flag used by counters.
 *   2. message_user_state UPSERT keyed by (mailbox_message_id, user_id) — the
 *      per-user record consulted by the list/detail queries.
 *
 * @param db — D1 database binding
 * @param mailboxMessageId — PK of the mailbox_messages row
 * @param userId — user marking the message read
 */
export async function markMessageAsRead(
  db: Database,
  mailboxMessageId: string,
  userId: string,
): Promise<void> {
  const now = new Date().toISOString();

  const updateMailboxMessage = db
    .prepare('UPDATE mailbox_messages SET is_read = 1 WHERE id = ?')
    .bind(mailboxMessageId);

  // ON CONFLICT(mailbox_message_id) keeps the existing user_id; the per-user
  // resolution query joins on both mailbox_message_id and user_id so a stale
  // row from another reader does not pollute this user's isRead.
  const upsertUserState = db
    .prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(mailbox_message_id) DO UPDATE SET
         is_read = 1,
         read_at = ?,
         updated_at = ?`,
    )
    .bind(mailboxMessageId, userId, now, now, now, now);

  await db.batch([updateMailboxMessage, upsertUserState]);
}
