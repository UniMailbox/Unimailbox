// message-read-repository — read-side queries for messages.
// Owner: messages module. Private file — export through modules/messages/index.ts.
//
// R-MESSAGE-005: isRead and isStarred persist per user. The list and detail queries join
// message_user_state for the requesting user so two members of the same mailbox
// see independent read state. mailbox_messages.is_read is a separate "any-reader"
// flag set by markMessageAsRead for use by unread-count aggregations; the API
// surface reports the per-user values. mailbox_messages.is_starred is retained
// only as a legacy compatibility column and is not authoritative.
// R-AUTHZ-004: Callers must have already asserted access to the mailbox; these
// queries authorise against the supplied mailboxId, never a client-supplied owner.
//
// R-MESSAGE-005 (delete half, CAP-043 Slice 1 / D-CAP-043-B): soft-delete
// is per-user on `message_user_state.is_deleted`. The inbox list query
// LEFT JOINs the per-user state and filters `COALESCE(mus.is_deleted, 0) = 0`
// so a soft-deleted row disappears from user A's list but remains in
// user B's list (asserted by the `keeps_per-user_isDeleted_independent`
// worker test in messages.worker.test.ts).
//
// R-API-005 (CAP-043 Slice 1 / D-CAP-043-D): the cursor is HMAC-SHA-256
// signed with `env.CURSOR_SIGNING_KEY`. The repository receives the
// resolved key string from the route layer (see platform/cursor.ts:
// signCursor / verifyCursor) and never reads the env directly. A
// tampered or malformed cursor surfaces as `null` from verifyCursor and
// the repository throws CursorInvalidError so the route can map it to
// a stable 400 INVALID_CURSOR envelope.
//
// CAP-071: migration 0041 materializes the established root on mailbox_messages.
// Triggers maintain header precedence atomically; the mailbox/root index bounds reads.

import {
  messageFolderSchema,
  type MessageAttachmentMetadata,
  type MessageFolder,
} from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { signCursor, verifyCursor, type CursorPayload } from '../../platform/cursor';
import { sqliteTimestamp } from '../../platform/idempotency';
import { systemClock } from '../../platform/clock';

export interface RecipientInfo {
  address: string;
  displayName: string;
}

export interface MessageListItem {
  id: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  isRead: 0 | 1;
  isStarred: 0 | 1;
  folder: MessageFolder;
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
  isRead: 0 | 1;
  isStarred: 0 | 1;
  folder: MessageFolder;
  createdAt: string;
  recipients: { to: RecipientInfo[]; cc: RecipientInfo[] };
  attachments: MessageAttachmentMetadata[];
}

export interface ListMessagesResult {
  items: MessageListItem[];
  nextCursor: string | null;
}

export interface MessageThread {
  rootId: string | null;
  items: MessageListItem[];
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

// D1 returns INTEGER columns as numbers. Normalize the constrained storage
// value at this boundary so the public contract remains the exact 0 | 1
// presentation type even if a corrupt/legacy row is encountered.
function stateFlag(value: number): 0 | 1 {
  return value === 1 ? 1 : 0;
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

interface MessageAttachmentDetailRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  disposition: 'attachment' | 'inline';
  content_id: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;

// Slice 2 fix G1 (sec M1): D1 rejects a statement that binds more than
// 100 parameters. The thread's recipients fetch binds one id per item,
// so the root-matching branch of getMessageThread caps its window at 50
// — the recipients IN clause then binds ≤50 ids under every condition.
// The window is the NEWEST 50 members; the oldest-first presentation
// order is restored in JS after the fetch.
const THREAD_MAX_ITEMS = 50;

/**
 * Thrown when the cursor the client supplied cannot be verified.
 *
 * The route catches this and renders a 400 INVALID_CURSOR. We do not
 * distinguish "malformed token" from "tampered token" because the two
 * are observationally equivalent for an attacker; a single error code
 * keeps the API surface stable (R-API-002 / R-API-005).
 */
export class CursorInvalidError extends Error {
  constructor() {
    super('Cursor is invalid or tampered with');
    this.name = 'CursorInvalidError';
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
 * R-MESSAGE-005:
 *   - isRead and isStarred are resolved per user via a LEFT JOIN on
 *     message_user_state.
 *   - isDeleted is filtered to 0 via `COALESCE(mus.is_deleted, 0) = 0`.
 *     A user who has never opened the message has no row; COALESCE
 *     reads 0 and the message shows. A user who soft-deleted has
 *     `is_deleted = 1` and the message is filtered out — but only for
 *     that user. Another user with no row sees it normally
 *     (D-CAP-043-B).
 *
 * R-API-005: the cursor is HMAC-SHA-256 signed (D-CAP-043-D). A
 * tampered or malformed cursor surfaces as `CursorInvalidError` so
 * the route returns a 400 INVALID_CURSOR envelope. The repository
 * accepts `cursorSigningKey` as a string parameter rather than
 * reading the env directly — `env` does not cross the module
 * boundary cleanly, and the route is the right place to resolve the
 * binding.
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access)
 * @param userId — requesting user; drives per-user isRead + is_deleted resolution
 * @param opts — cursor + limit + signing key
 */
export async function listMessagesByMailbox(
  db: Database,
  mailboxId: string,
  userId: string,
  opts: { cursor?: string; limit?: number; cursorSigningKey: string; folder?: MessageFolder },
): Promise<ListMessagesResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const folder = opts.folder ?? 'inbox';

  // Verify the cursor BEFORE running the page query. verifyCursor
  // returns null on any failure (malformed token, signature mismatch,
  // unparseable payload). The route catches CursorInvalidError and
  // returns 400 INVALID_CURSOR; nothing the client sent past this
  // point can be misinterpreted as a valid page boundary.
  let cursor: CursorPayload | null = null;
  if (opts.cursor !== undefined && opts.cursor.length > 0) {
    // CAP-044 Slice 2 fix (d): this endpoint's surface is 'messages' — a
    // cursor minted by any other cursor-paginated API (audit-events) is
    // rejected here as INVALID_CURSOR, not replayed across surfaces.
    const verified = await verifyCursor(opts.cursor, opts.cursorSigningKey, 'messages');
    if (verified === null) {
      throw new CursorInvalidError();
    }
    cursor = verified;
    // CAP-059: every messages cursor minted by this slice carries the
    // selected folder. Reject older scope-less tokens as well; accepting one
    // would let a cursor silently skip rows when a caller switches views.
    if (cursor.scope !== `folder:${folder}`) {
      throw new CursorInvalidError();
    }
  }

  // Page query: join mailbox_messages → messages, LEFT JOIN per-user state.
  // Cursor slot bound to null when no cursor so the WHERE is a no-op.
  // R-MESSAGE-005: COALESCE(mus.is_deleted, 0) = 0 hides the user's
  // soft-deleted rows; users who never opened the message have no
  // mus row, COALESCE returns 0, and the message shows.
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = await db
    .prepare(
      `SELECT m.id, m.from_address, m.from_name, m.subject,
              COALESCE(mus.is_starred, 0) AS is_starred, mm.folder, m.created_at,
              COALESCE(mus.is_read, 0) AS user_is_read
         FROM mailbox_messages mm
         JOIN messages m ON mm.message_id = m.id
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND mm.folder = ?
          AND COALESCE(mus.is_deleted, 0) = 0
          AND (? IS NULL
               OR (m.created_at < ? OR (m.created_at = ? AND m.id < ?)))
     ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .bind(
      userId,
      mailboxId,
      folder,
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
    isRead: stateFlag(row.user_is_read),
    isStarred: stateFlag(row.is_starred),
    folder: messageFolderSchema.parse(row.folder),
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
  // R-API-005: signed with the same HMAC key the request verified with
  // so the client's next request continues the chain end-to-end.
  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = await signCursor(
        { createdAt: last.createdAt, id: last.id, surface: 'messages', scope: `folder:${folder}` },
        opts.cursorSigningKey,
      );
    }
  }

  return { items, nextCursor };
}

/**
 * Loads a single message with its recipients, scoped to a mailbox.
 *
 * R-MESSAGE-005: isRead is resolved per user, same strategy as the list
 * query. Soft-delete is too (Slice 2 fix G2, arch M1 / code M4 / sec L2):
 * `COALESCE(mus.is_deleted, 0) = 0` filters the calling user's
 * soft-deleted rows so the detail 404s exactly what the inbox list
 * hides — without it the detail leaked messages the caller had deleted
 * (D-CAP-043-B).
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
              m.status, COALESCE(mus.is_starred, 0) AS is_starred, mm.folder, m.created_at,
              COALESCE(mus.is_read, 0) AS user_is_read
         FROM mailbox_messages mm
         JOIN messages m ON mm.message_id = m.id
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND mm.message_id = ?
          AND COALESCE(mus.is_deleted, 0) = 0`,
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

  // R-ATTACHMENT-001 / R-ATTACHMENT-006: only persisted relations whose
  // upload has completed the consume transition are visible. The public
  // detail projection deliberately selects no upload ID, object key, or
  // byte-store field (R-SECRET-003). Stable ordering uses the relation's
  // canonical creation timestamp and UUID tie-breaker.
  const attachmentRows = await db
    .prepare(
      `SELECT ma.id AS id,
              ma.filename AS filename,
              ma.content_type AS content_type,
              ma.size_bytes AS size_bytes,
              ma.disposition AS disposition,
              ma.content_id AS content_id
         FROM message_attachments ma
         JOIN attachment_uploads au
           ON au.id = ma.upload_id
          AND au.status = 'consumed'
        WHERE ma.message_id = ?
        ORDER BY ma.created_at ASC, ma.id ASC`,
    )
    .bind(messageId)
    .all<MessageAttachmentDetailRow>();

  const inboundAttachmentRows = await db
    .prepare(
      `SELECT id, filename, content_type, size_bytes, disposition, content_id
         FROM inbound_message_attachments
        WHERE message_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .bind(messageId)
    .all<MessageAttachmentDetailRow>();

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
    isRead: stateFlag(row.user_is_read),
    isStarred: stateFlag(row.is_starred),
    folder: messageFolderSchema.parse(row.folder),
    createdAt: row.created_at,
    recipients: groupRecipients(recipientRows.results ?? []),
    attachments: [...(attachmentRows.results ?? []), ...(inboundAttachmentRows.results ?? [])].map(
      (attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        sizeBytes: attachment.size_bytes,
        disposition: attachment.disposition,
        contentId: attachment.content_id,
      }),
    ),
  };
}

/**
 * Returns the same-thread messages for one mailbox, oldest-first
 * (CAP-043 AC 9).
 *
 * The thread root of the ANCHOR message is resolved first (query A),
 * then every message in the SAME MAILBOX whose own resolved root equals
 * it is returned (query B). Both sides use the persisted mailbox thread_root, so the
 * D-CAP-043-C priority order lives in exactly one place. Cross-mailbox:
 * only rows joined through this mailbox's `mailbox_messages` are
 * considered — a message that exists in another mailbox is invisible
 * here (no existence leak; the caller surfaces 404).
 *
 * R-MESSAGE-005: per-user semantics on both sides —
 *   - the ANCHOR must not be soft-deleted for the calling user (a
 *     soft-deleted anchor is "gone" for that user, same as the inbox
 *     list treats it), otherwise null → 404;
 *   - thread ITEMS exclude the calling user's soft-deleted rows, so
 *     one member's delete shrinks their thread but not another
 *     member's (D-CAP-043-B).
 *
 * When the anchor's resolved root is NULL (no thread_id, no usable
 * references token, no in-reply-to, no message-id header) the thread is
 * the singleton anchor: NULL-root rows are not matched against each
 * other, because two unrelated header-less messages must never fuse
 * into one thread.
 *
 * Slice 2 fix G1 (sec M1): the root-matching branch returns only the
 * NEWEST THREAD_MAX_ITEMS members (see the constant's comment for the
 * D1 bound-parameter limit). `rootId` in the response stays correct and
 * the anchor itself is rendered by the detail query, so the window is
 * presentation-only; the oldest members (including, in a 50+ thread,
 * possibly the root) fall outside it.
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access)
 * @param messageId — the anchor message (the one the user opened)
 * @param userId — requesting user; drives per-user isRead + is_deleted
 */
export async function getMessageThread(
  db: Database,
  mailboxId: string,
  messageId: string,
  userId: string,
): Promise<MessageThread | null> {
  // Query A: resolve the anchor's thread root. The soft-delete filter
  // rides along so a soft-deleted-for-caller anchor returns null (404)
  // instead of a thread the caller's inbox would not link to.
  const anchor = await db
    .prepare(
      `SELECT mm.thread_root AS resolved_root
         FROM mailbox_messages mm
         JOIN messages m ON mm.message_id = m.id
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND mm.message_id = ?
          AND COALESCE(mus.is_deleted, 0) = 0`,
    )
    .bind(userId, mailboxId, messageId)
    .first<{ resolved_root: string | null }>();

  if (!anchor) {
    return null;
  }

  const rootId: string | null = anchor.resolved_root;

  // Query B: same-mailbox members of the resolved root, excluding the
  // calling user's soft-deleted rows, capped at the newest
  // THREAD_MAX_ITEMS (G1 — see the constant). A NULL root is the
  // singleton case — match the anchor by id only (see doc comment);
  // structurally ≤1 row by the unique index, so no cap is needed.
  const rows = await db
    .prepare(
      rootId === null
        ? `SELECT m.id, m.from_address, m.from_name, m.subject,
                  COALESCE(mus.is_starred, 0) AS is_starred, mm.folder, m.created_at,
                  COALESCE(mus.is_read, 0) AS user_is_read
             FROM mailbox_messages mm
             JOIN messages m ON mm.message_id = m.id
        LEFT JOIN message_user_state mus
                  ON mus.mailbox_message_id = mm.id
                 AND mus.user_id = ?
            WHERE mm.mailbox_id = ?
              AND COALESCE(mus.is_deleted, 0) = 0
              AND mm.message_id = ?
         ORDER BY m.created_at ASC, m.id ASC`
        : `SELECT m.id, m.from_address, m.from_name, m.subject,
                  COALESCE(mus.is_starred, 0) AS is_starred, mm.folder, m.created_at,
                  COALESCE(mus.is_read, 0) AS user_is_read
             FROM mailbox_messages mm
             JOIN messages m ON mm.message_id = m.id
        LEFT JOIN message_user_state mus
                  ON mus.mailbox_message_id = mm.id
                 AND mus.user_id = ?
            WHERE mm.mailbox_id = ?
              AND COALESCE(mus.is_deleted, 0) = 0
              AND mm.thread_root = ?
         ORDER BY m.created_at DESC, m.id DESC
            LIMIT ?`,
    )
    .bind(
      ...(rootId === null
        ? [userId, mailboxId, messageId]
        : [userId, mailboxId, rootId, THREAD_MAX_ITEMS]),
    )
    .all<MessageListRow>();

  // G1: the root branch fetched newest-first under the cap; restore the
  // oldest-first presentation order the contract promises. The
  // singleton branch already returns ASC and needs no reversal.
  const orderedRows = rootId === null ? (rows.results ?? []) : [...(rows.results ?? [])].reverse();
  const items: MessageListItem[] = orderedRows.map((row) => ({
    id: row.id,
    fromAddress: row.from_address,
    fromName: row.from_name,
    subject: row.subject,
    isRead: stateFlag(row.user_is_read),
    isStarred: stateFlag(row.is_starred),
    folder: messageFolderSchema.parse(row.folder),
    createdAt: row.created_at,
    recipients: { to: [], cc: [] },
  }));

  // Recipients for the thread's message IDs (same shape as the list query).
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

  return { rootId, items };
}

/**
 * Marks a message as read for a specific user, resolving the
 * mailbox_message row from (mailboxId, messageId) itself.
 *
 * Slice 3 fix H6: the row lookup lives here, not as raw SQL in the route
 * handler — the route layer validates and calls one module function.
 *
 * Two writes run in one D1 batch (R-MESSAGE-005):
 *   1. mailbox_messages.is_read = 1 — the "any reader" flag used by counters.
 *   2. message_user_state UPSERT keyed by (mailbox_message_id, user_id) — the
 *      per-user record consulted by the list/detail queries. Every member
 *      gets their own row (PK per D-CAP-043-F / migration 0017), so the
 *      second reader's write cannot collide with or clobber the first
 *      reader's state.
 *
 * Slice 3 fix H5: `updated_at` / `read_at` are written as
 * `sqliteTimestamp(systemClock.now())` — the column DEFAULT is
 * `datetime('now')`, and mixing an ISO-8601 string into the same TEXT
 * column is a silent ordering bug (see platform/idempotency.ts
 * sqliteTimestamp for the full rationale).
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access)
 * @param messageId — target message
 * @param userId — user marking the message read
 * @returns true when the message was found and marked; false when no
 *   `mailbox_messages` row exists for the (mailbox, message) pair — the
 *   caller surfaces 404 MESSAGE_NOT_FOUND (same envelope as every other
 *   not-found path; no cross-mailbox existence leak).
 */
export async function markMessageAsRead(
  db: Database,
  mailboxId: string,
  messageId: string,
  userId: string,
): Promise<boolean> {
  const mailboxMessage = await db
    .prepare('SELECT id FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?')
    .bind(mailboxId, messageId)
    .first<{ id: string }>();

  if (!mailboxMessage) {
    return false;
  }

  const now = sqliteTimestamp(systemClock.now());

  const updateMailboxMessage = db
    .prepare('UPDATE mailbox_messages SET is_read = 1 WHERE id = ?')
    .bind(mailboxMessage.id);

  // R-MESSAGE-005 / D-CAP-043-F: one row per (mailbox_message, user). The
  // conflict target is the composite PK, so a second member reading the
  // same message UPSERTs their own row and re-reading refreshes only the
  // calling user's read_at / updated_at.
  const upsertUserState = db
    .prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(mailbox_message_id, user_id) DO UPDATE SET
         is_read = 1,
         read_at = ?,
         updated_at = ?`,
    )
    .bind(mailboxMessage.id, userId, now, now, now, now);

  await db.batch([updateMailboxMessage, upsertUserState]);

  return true;
}

/**
 * Reads the current star flag for one user (CAP-058, R-MESSAGE-005).
 *
 * The route reads the current flag, computes the target, and folds
 * `prepareSetMessageStar` into the same D1 batch as the idempotency record
 * and audit row. The two-step read/compute/write shape keeps the response
 * deterministic while the batch keeps the non-re-runnable toggle atomic
 * (R-API-004).
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access)
 * @param messageId — target message
 * @param userId — requesting user whose state is read
 * @returns the user's current `is_starred` (true/false), or null when no
 *   `mailbox_messages` row exists for the (mailbox, message) pair.
 */
export async function getMessageStarState(
  db: Database,
  mailboxId: string,
  messageId: string,
  userId: string,
): Promise<boolean | null> {
  const row = await db
    .prepare(
      `SELECT COALESCE(mus.is_starred, 0) AS is_starred
         FROM mailbox_messages mm
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND mm.message_id = ?
          AND COALESCE(mus.is_deleted, 0) = 0`,
    )
    .bind(userId, mailboxId, messageId)
    .first<{ is_starred: number }>();

  return row === null ? null : row.is_starred === 1;
}

/**
 * Prepared per-user star UPSERT setting a KNOWN target (CAP-058,
 * R-MESSAGE-005). The INSERT ... SELECT scopes the state row through the
 * requested mailbox/message association. Only `is_starred` and
 * `updated_at` are changed on conflict; read and soft-delete state on the
 * same composite row is preserved.
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox
 * @param messageId — target message
 * @param userId — requesting user whose state is written
 * @param target — the computed post-toggle value (SQLite 0/1)
 * @param updatedAt — deterministic SQLite timestamp for the state write
 */
export function prepareSetMessageStar(
  db: Database,
  mailboxId: string,
  messageId: string,
  userId: string,
  target: 0 | 1,
  updatedAt = sqliteTimestamp(systemClock.now()),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_starred, updated_at)
       SELECT mm.id, ?, ?, ?
         FROM mailbox_messages mm
        WHERE mm.mailbox_id = ?
          AND mm.message_id = ?
       ON CONFLICT(mailbox_message_id, user_id) DO UPDATE SET
         is_starred = excluded.is_starred,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, target, updatedAt, mailboxId, messageId);
}

/**
 * Builds the prepared per-user soft-delete UPSERT for ONE user (CAP-043
 * Slice 3 fix H2, D-CAP-043-B, R-MESSAGE-005). The write is per-user state
 * only — no other member's view changes (AC 17). The caller folds the
 * returned statement into the SAME D1 batch as the idempotency record and
 * audit row, so the delete, its replay record, and its audit row are
 * atomic (R-API-004).
 *
 * Gate 1 (Slice 1 review, sec M2): the UPSERT conflicts on the post-0017
 * composite PK `(mailbox_message_id, user_id)` and the DO UPDATE SET lists
 * ONLY `is_deleted`, `deleted_at`, `updated_at` — an existing row's
 * `is_read` / `read_at` are preserved, so deleting a read message does not
 * silently unread it.
 *
 * Slice 3 fix H5: `updated_at` / `deleted_at` are written as
 * `sqliteTimestamp(systemClock.now())` to match the column DEFAULT's
 * `datetime('now')` format.
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access
 *   per D-CAP-043-H)
 * @param messageId — target message
 * @param userId — the user deleting; only their row is written
 * @returns the bound UPSERT statement, or null when no `mailbox_messages`
 *   row exists for the (mailbox, message) pair — the caller surfaces 404
 *   MESSAGE_NOT_FOUND (same envelope as a non-existent message; no
 *   cross-mailbox existence leak).
 */
export async function prepareSoftDeleteMessageForUser(
  db: Database,
  mailboxId: string,
  messageId: string,
  userId: string,
): Promise<D1PreparedStatement | null> {
  const mailboxMessage = await db
    .prepare('SELECT id FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?')
    .bind(mailboxId, messageId)
    .first<{ id: string }>();

  if (!mailboxMessage) {
    return null;
  }

  const now = sqliteTimestamp(systemClock.now());

  return db
    .prepare(
      `INSERT INTO message_user_state (mailbox_message_id, user_id, is_read, read_at, updated_at, is_deleted, deleted_at)
       VALUES (?, ?, 0, NULL, ?, 1, ?)
       ON CONFLICT(mailbox_message_id, user_id) DO UPDATE SET
         is_deleted = 1,
         deleted_at = ?,
         updated_at = ?`,
    )
    .bind(mailboxMessage.id, userId, now, now, now, now);
}
