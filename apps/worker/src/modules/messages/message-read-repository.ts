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
// CAP-043 Slice 2 / D-CAP-043-C: getMessageThread computes the thread
// root at READ time (thread_id → first <…> token of references_header →
// in_reply_to_header → own message_id_header). See THREAD_ROOT_SQL —
// the priority order exists only there so the anchor and the candidate
// rows can never drift apart.

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
 * D-CAP-043-C: the thread root, resolved at read time. One SQL
 * expression, interpolated into both thread queries so the anchor and
 * the candidate rows can never drift apart on priority order.
 *
 * Priority (first non-empty wins):
 *   1. `m.thread_id` — the column wins when set (it will become the
 *      authoritative value once a future capability backfills it).
 *   2. The first `<…>` msg-id token of `references_header`, brackets
 *      KEPT. Threading headers are stored verbatim from RFC 5322
 *      (§3.6.3: msg-id includes the angle brackets), so `message_id_header`
 *      and `in_reply_to_header` carry `<id@host>` strings. A bracket-
 *      stripped token would never equal them and threads would never
 *      assemble.
 *   3. `m.in_reply_to_header` (verbatim).
 *   4. `m.message_id_header` (verbatim) — the singleton case. An EMPTY
 *      string normalises to NULL via NULLIF (G3): an empty-string
 *      Message-ID must resolve like a missing one, otherwise every
 *      header-less message whose writer stored `''` would share the
 *      root `''` and unrelated messages would fuse into one thread.
 *
 * The References guard is `instr(…) > instr(… '<')` so a malformed
 * value with a `>` before any `<` cannot produce a negative-length
 * substr; a references value with no `<…>` pair falls through to the
 * next priority.
 *
 * Resolves to NULL only when all four sources are empty/NULL — the
 * caller treats that as a singleton thread (the anchor alone).
 */
const THREAD_ROOT_SQL = `CASE
  WHEN m.thread_id IS NOT NULL AND m.thread_id != '' THEN m.thread_id
  WHEN instr(m.references_header, '<') > 0
       AND instr(m.references_header, '>') > instr(m.references_header, '<') THEN
    substr(m.references_header, instr(m.references_header, '<'),
           instr(m.references_header, '>') - instr(m.references_header, '<') + 1)
  WHEN m.in_reply_to_header IS NOT NULL AND m.in_reply_to_header != '' THEN m.in_reply_to_header
  ELSE NULLIF(m.message_id_header, '')
END`;

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
 *   - isRead is resolved per user via a LEFT JOIN on message_user_state.
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
  opts: { cursor?: string; limit?: number; cursorSigningKey: string },
): Promise<ListMessagesResult> {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

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
              mm.is_starred, mm.folder, m.created_at,
              COALESCE(mus.is_read, 0) AS user_is_read
         FROM mailbox_messages mm
         JOIN messages m ON mm.message_id = m.id
    LEFT JOIN message_user_state mus
              ON mus.mailbox_message_id = mm.id
             AND mus.user_id = ?
        WHERE mm.mailbox_id = ?
          AND COALESCE(mus.is_deleted, 0) = 0
          AND (? IS NULL
               OR (m.created_at < ? OR (m.created_at = ? AND m.id < ?)))
     ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .bind(userId, mailboxId, cursorCreatedAt, cursorCreatedAt, cursorCreatedAt, cursorId, limit)
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
  // R-API-005: signed with the same HMAC key the request verified with
  // so the client's next request continues the chain end-to-end.
  let nextCursor: string | null = null;
  if (items.length === limit && items.length > 0) {
    const last = items[items.length - 1];
    if (last) {
      nextCursor = await signCursor(
        { createdAt: last.createdAt, id: last.id, surface: 'messages' },
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
              m.status, mm.is_starred, mm.folder, m.created_at,
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
 * Returns the same-thread messages for one mailbox, oldest-first
 * (CAP-043 AC 9).
 *
 * The thread root of the ANCHOR message is resolved first (query A),
 * then every message in the SAME MAILBOX whose own resolved root equals
 * it is returned (query B). Both sides use THREAD_ROOT_SQL, so the
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
      `SELECT ${THREAD_ROOT_SQL} AS resolved_root
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
                  mm.is_starred, mm.folder, m.created_at,
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
                  mm.is_starred, mm.folder, m.created_at,
                  COALESCE(mus.is_read, 0) AS user_is_read
             FROM mailbox_messages mm
             JOIN messages m ON mm.message_id = m.id
        LEFT JOIN message_user_state mus
                  ON mus.mailbox_message_id = mm.id
                 AND mus.user_id = ?
            WHERE mm.mailbox_id = ?
              AND COALESCE(mus.is_deleted, 0) = 0
              AND ${THREAD_ROOT_SQL} = ?
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
  const orderedRows =
    rootId === null
      ? (rows.results ?? [])
      : [...(rows.results ?? [])].reverse();
  const items: MessageListItem[] = orderedRows.map((row) => ({
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
 * Reads the current mailbox-level star flag (CAP-043 Slice 3 fix H1,
 * D-CAP-043-A).
 *
 * H1 replaced the single-statement `NOT is_starred` toggle with a
 * read-compute-write pair: the route reads the current flag, computes the
 * target, and folds `prepareSetMessageStar` into the SAME D1 batch as the
 * idempotency record + audit row. A batched `UPDATE … RETURNING` cannot
 * feed the record's `responseJson` (D1 binds all statement values at
 * prepare time), hence the two-step shape — see the route for the
 * batch-atomicity rationale (R-API-004: a non-re-runnable write must
 * never execute under best-effort idempotency).
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox (caller must have asserted read access
 *   per D-CAP-043-H)
 * @param messageId — target message
 * @returns the current `is_starred` (true/false), or null when no
 *   `mailbox_messages` row exists for the (mailbox, message) pair — the
 *   caller surfaces 404 MESSAGE_NOT_FOUND.
 */
export async function getMessageStarState(
  db: Database,
  mailboxId: string,
  messageId: string,
): Promise<boolean | null> {
  const row = await db
    .prepare('SELECT is_starred FROM mailbox_messages WHERE mailbox_id = ? AND message_id = ?')
    .bind(mailboxId, messageId)
    .first<{ is_starred: number }>();

  return row === null ? null : row.is_starred === 1;
}

/**
 * Prepared `UPDATE` setting the mailbox-level star flag to a KNOWN target
 * (CAP-043 Slice 3 fix H1, D-CAP-043-A). The route computes `target` from
 * `getMessageStarState`'s read and appends this statement to the batch
 * that also carries the idempotency record and the audit row — the star
 * write, its replay record, and its audit row commit or roll back
 * together.
 *
 * `is_starred` is deliberately NOT per-user: the deferral to
 * `message_user_state.is_starred` is recorded in D-CAP-043-A, so any
 * member's star is every member's star (AC 17).
 *
 * The read→batch window for DIFFERENT-key concurrent toggles stays
 * last-write-wins (gate 5 / D-CAP-043-A).
 *
 * @param db — D1 database binding
 * @param mailboxId — target mailbox
 * @param messageId — target message
 * @param target — the computed post-toggle value (SQLite 0/1)
 */
export function prepareSetMessageStar(
  db: Database,
  mailboxId: string,
  messageId: string,
  target: 0 | 1,
): D1PreparedStatement {
  return db
    .prepare('UPDATE mailbox_messages SET is_starred = ? WHERE mailbox_id = ? AND message_id = ?')
    .bind(target, mailboxId, messageId);
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
