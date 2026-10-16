import { createDraftSchema, updateDraftSchema, uuidSchema } from '@unimailbox/contracts';
import { assertCan, findMailboxById } from '../tenancy';
import { createMessageWithRelations } from './message-repository';
import { resolveAuthorizedMessageMailbox } from './authored-message-repository';
import { DomainError } from '../../platform/errors';
import {
  findIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  assertSameRequestHash,
  sha256Hex,
  sqliteTimestamp,
  isIdempotencyUniqueViolation,
  IDEMPOTENCY_TTL_HOURS,
} from '../../platform/idempotency';
import { parseJsonBody } from '../../platform/parse-json-body';
import {
  operationResult,
  replayOperation,
  replayOperationAfterRace,
  type OperationResult,
  type MutationDependencies,
  type MutationInput,
  prepareOperationAudit,
} from '../../platform/operation';

const CREATE_DRAFT_OPERATION = 'POST /api/v1/mailboxes/:mailboxId/drafts';
const PATCH_DRAFT_OPERATION = 'PATCH /api/v1/drafts/:draftId';
const IF_MATCH_CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;

function parseIfMatch(header: string | undefined): string {
  if (header === undefined) {
    throw new DomainError({
      code: 'IF_MATCH_REQUIRED',
      message: 'If-Match header required',
      httpStatus: 400,
    });
  }
  const trimmed = header.trim();

  if (trimmed.startsWith('W/')) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must be the canonical RFC-3339 updated_at without W/ prefix',
      httpStatus: 400,
    });
  }

  if (trimmed.startsWith('"') || trimmed.endsWith('"')) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must be the canonical RFC-3339 updated_at without quotes',
      httpStatus: 400,
    });
  }
  if (!IF_MATCH_CANONICAL_RE.test(trimmed)) {
    throw new DomainError({
      code: 'IF_MATCH_INVALID',
      message: 'If-Match header must match YYYY-MM-DDTHH:MM:SS.000Z exactly',
      httpStatus: 400,
    });
  }
  return trimmed;
}

function ifMatchToSqlite(ifMatch: string): string {
  return ifMatch.slice(0, 19).replace('T', ' ');
}

function replayDraftWithLocation(result: OperationResult): OperationResult {
  const payload = JSON.parse(result.responseJson) as { data?: { messageId?: unknown } };
  return typeof payload.data?.messageId === 'string'
    ? {
        ...result,
        headers: { ...result.headers, Location: '/api/v1/drafts/' + payload.data.messageId },
      }
    : result;
}

const SQLITE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function sqliteTimestampToRFC3339(value: string): string {
  const match = SQLITE_DATETIME_RE.exec(value);
  if (!match) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Malformed stored timestamp',
      httpStatus: 500,
    });
  }
  const [, year, month, day, hour, minute, second] = match;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

export async function createDraft(
  deps: MutationDependencies,
  input: MutationInput & { mailboxId: string },
): Promise<OperationResult> {
  const userId = input.actorUserId;
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  const mailboxId = input.mailboxId;

  await assertCan(deps.db, userId, mailboxId, 'send');

  const rawBody = input.rawBody;
  const requestHash = await sha256Hex(rawBody);

  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }

  const existing = await findIdempotencyRecord(
    deps.db,
    userId,
    CREATE_DRAFT_OPERATION,
    idempotencyKey,
  );
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    return replayDraftWithLocation(replayOperation(existing));
  }

  const body = parseJsonBody(rawBody, createDraftSchema, {
    event: 'drafts.create.invalid_json',
    actorUserId: userId,
  });

  const mailbox = await findMailboxById(deps.db, mailboxId);
  if (!mailbox) {
    throw new DomainError({
      code: 'MAILBOX_NOT_FOUND',
      message: 'Mailbox not found',
      httpStatus: 404,
    });
  }

  const nowDate = deps.clock.now();
  const nowSqlite = sqliteTimestamp(nowDate);
  const nowWire = nowDate.toISOString();

  const messageId = deps.ids.uuid();
  const auditEventId = deps.ids.uuid();
  const idempotencyRecordId = deps.ids.uuid();

  const requestId = input.requestId ?? null;

  const successBody = JSON.stringify({
    data: { messageId, status: 'draft', updatedAt: nowWire },
  });

  const statements: D1PreparedStatement[] = [
    deps.db
      .prepare(
        `INSERT INTO messages (
             id, from_address, from_name, subject, html_body, text_body,
             message_id_header, in_reply_to_header, references_header,
             status, created_by_user_id, created_at, updated_at
           ) VALUES (?, ?, '', ?, ?, ?, NULL, NULL, '', 'draft', ?, ?, ?)`,
      )
      .bind(
        messageId,
        mailbox.address,
        body.subject,
        body.body_html ?? '',
        body.body_text,
        userId,
        nowSqlite,
        nowSqlite,
      ),

    ...body.to.map((address) =>
      deps.db
        .prepare(
          `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, '', 'to', ?)`,
        )
        .bind(deps.ids.uuid(), messageId, address, nowSqlite),
    ),

    ...body.cc.map((address) =>
      deps.db
        .prepare(
          `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, '', 'cc', ?)`,
        )
        .bind(deps.ids.uuid(), messageId, address, nowSqlite),
    ),

    ...body.bcc.map((address) =>
      deps.db
        .prepare(
          `INSERT INTO message_recipients (id, message_id, address, display_name, type, created_at)
             VALUES (?, ?, ?, '', 'bcc', ?)`,
        )
        .bind(deps.ids.uuid(), messageId, address, nowSqlite),
    ),

    deps.db
      .prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, is_read, is_starred, folder, created_at)
           VALUES (?, ?, ?, 1, 0, 'drafts', ?)`,
      )
      .bind(deps.ids.uuid(), mailboxId, messageId, nowSqlite),

    prepareOperationAudit(deps.auditEventWriter, {
      id: auditEventId,
      actorUserId: userId,
      action: 'draft.created',
      resourceType: 'message',
      resourceId: messageId,
      requestId,
      createdAt: nowSqlite,
    }),

    prepareCreateIdempotencyRecord(deps.db, {
      id: idempotencyRecordId,
      actorId: userId,
      operation: CREATE_DRAFT_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 201,
      responseJson: successBody,
      createdAt: nowSqlite,
    }),
  ];

  try {
    await createMessageWithRelations(deps.db, statements);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      return replayDraftWithLocation(
        await replayOperationAfterRace(
          deps.db,
          userId,
          CREATE_DRAFT_OPERATION,
          idempotencyKey,
          requestHash,
        ),
      );
    }
    throw error;
  }

  return operationResult(successBody, {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      Location: `/api/v1/drafts/${messageId}`,
    },
  });
}

export async function readDraft(
  deps: MutationDependencies,
  input: Pick<MutationInput, 'actorUserId'> & { draftId: string; mailboxId: string | undefined },
): Promise<OperationResult> {
  const userId = input.actorUserId;
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  const draftId = input.draftId;

  const requestedMailboxId = input.mailboxId;
  if (requestedMailboxId !== undefined && !uuidSchema.safeParse(requestedMailboxId).success) {
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      httpStatus: 404,
    });
  }

  const authorizedMailboxId = await resolveAuthorizedMessageMailbox(deps.db, {
    actorUserId: userId,
    messageId: draftId,
    operation: 'read',
    draftOnly: true,
    ...(requestedMailboxId === undefined ? {} : { mailboxId: requestedMailboxId }),
  });

  const draftRow = await deps.db
    .prepare(
      `SELECT m.id         AS id,
              m.subject    AS subject,
              m.html_body  AS html_body,
              m.text_body  AS text_body,
              m.status     AS status,
              m.created_at AS created_at,
              m.updated_at AS updated_at
         FROM messages m
        WHERE m.id = ?
          AND m.status = 'draft'
          AND EXISTS (
            SELECT 1 FROM mailbox_messages mm
             WHERE mm.message_id = m.id
               AND mm.mailbox_id = ?
          )
        LIMIT 1`,
    )
    .bind(draftId, authorizedMailboxId)
    .first<{
      id: string;
      subject: string;
      html_body: string;
      text_body: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>();

  if (!draftRow) {
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      httpStatus: 404,
    });
  }

  const recipientRows = await deps.db
    .prepare(
      `SELECT type, address
           FROM message_recipients
          WHERE message_id = ?
       ORDER BY type, address`,
    )
    .bind(draftId)
    .all<{ type: 'to' | 'cc' | 'bcc'; address: string }>();

  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];
  for (const row of recipientRows.results ?? []) {
    if (row.type === 'to') to.push(row.address);
    else if (row.type === 'cc') cc.push(row.address);
    else if (row.type === 'bcc') bcc.push(row.address);
  }

  const body = {
    data: {
      id: draftRow.id,
      mailboxId: authorizedMailboxId,
      subject: draftRow.subject,
      body_text: draftRow.text_body,
      body_html: draftRow.html_body,
      to,
      cc,
      bcc,
      status: draftRow.status,
      created_at: sqliteTimestampToRFC3339(draftRow.created_at),
      updated_at: sqliteTimestampToRFC3339(draftRow.updated_at),
    },
  };

  return operationResult(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function updateDraft(
  deps: MutationDependencies,
  input: MutationInput & { draftId: string; ifMatch: string | undefined },
): Promise<OperationResult> {
  const userId = input.actorUserId;
  if (!userId) {
    throw new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
      httpStatus: 401,
    });
  }

  const draftId = input.draftId;

  const authorizedMailboxId = await resolveAuthorizedMessageMailbox(deps.db, {
    actorUserId: userId,
    messageId: draftId,
    operation: 'send',
    draftOnly: true,
  });

  const ifMatchHeader = input.ifMatch;
  const ifMatch = parseIfMatch(ifMatchHeader);
  const ifMatchSqlite = ifMatchToSqlite(ifMatch);

  const idempotencyKey = input.idempotencyKey;
  if (!idempotencyKey) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header required',
      httpStatus: 400,
    });
  }

  const rawBody = input.rawBody;
  const requestHash = await sha256Hex(rawBody);

  const existing = await findIdempotencyRecord(
    deps.db,
    userId,
    PATCH_DRAFT_OPERATION,
    idempotencyKey,
  );
  if (existing) {
    assertSameRequestHash(existing, requestHash);
    return replayOperation(existing);
  }

  const body = parseJsonBody(rawBody, updateDraftSchema, {
    event: 'drafts.patch.invalid_json',
    actorUserId: userId,
  });

  const currentRow = await deps.db
    .prepare(
      `SELECT m.id         AS id,
                m.subject    AS subject,
                m.html_body  AS html_body,
                m.text_body  AS text_body,
                m.created_at AS created_at,
                m.updated_at AS updated_at
           FROM messages m
          WHERE m.id = ?
            AND m.status = 'draft'
            AND EXISTS (
              SELECT 1 FROM mailbox_messages mm
               WHERE mm.message_id = m.id
                 AND mm.mailbox_id = ?
            )
          LIMIT 1`,
    )
    .bind(draftId, authorizedMailboxId)
    .first<{
      id: string;
      subject: string;
      html_body: string;
      text_body: string;
      created_at: string;
      updated_at: string;
    }>();

  if (!currentRow) {
    throw new DomainError({
      code: 'MESSAGE_NOT_FOUND',
      message: 'Message not found',
      httpStatus: 404,
    });
  }

  if (currentRow.updated_at !== ifMatchSqlite) {
    const preWinner = await findIdempotencyRecord(
      deps.db,
      userId,
      PATCH_DRAFT_OPERATION,
      idempotencyKey,
    );
    if (preWinner) {
      assertSameRequestHash(preWinner, requestHash);
      return replayOperation(preWinner);
    }

    throw new DomainError({
      code: 'STALE_IF_MATCH',
      message: 'If-Match header does not match the current updated_at',
      httpStatus: 412,
    });
  }

  const recipientRows = await deps.db
    .prepare(
      `SELECT type, address
           FROM message_recipients
          WHERE message_id = ?
       ORDER BY type, address`,
    )
    .bind(draftId)
    .all<{ type: 'to' | 'cc' | 'bcc'; address: string }>();

  const existingTo: string[] = [];
  const existingCc: string[] = [];
  const existingBcc: string[] = [];
  for (const row of recipientRows.results ?? []) {
    if (row.type === 'to') existingTo.push(row.address);
    else if (row.type === 'cc') existingCc.push(row.address);
    else if (row.type === 'bcc') existingBcc.push(row.address);
  }

  const mergedTo = body.to !== undefined ? body.to : existingTo;
  const mergedCc = body.cc !== undefined ? body.cc : existingCc;
  const mergedBcc = body.bcc !== undefined ? body.bcc : existingBcc;

  const nowDate = deps.clock.now();
  const candidateSqlite = sqliteTimestamp(nowDate);
  let newSqlite: string;
  if (candidateSqlite > ifMatchSqlite) {
    newSqlite = candidateSqlite;
  } else {
    const advanced = new Date(`${ifMatchSqlite.replace(' ', 'T')}Z`);
    advanced.setUTCSeconds(advanced.getUTCSeconds() + 1);
    newSqlite = sqliteTimestamp(advanced);
  }

  const newWire = `${newSqlite.replace(' ', 'T')}.000Z`;

  if (newSqlite <= ifMatchSqlite) {
    throw new DomainError({
      code: 'INTERNAL',
      message: 'Computed updated_at did not advance past the stored value',
      httpStatus: 500,
    });
  }

  const responseBody = JSON.stringify({
    data: {
      id: currentRow.id,
      mailboxId: authorizedMailboxId,
      subject: body.subject ?? currentRow.subject,
      body_text: body.body_text ?? currentRow.text_body,
      body_html: body.body_html ?? currentRow.html_body,
      to: mergedTo,
      cc: mergedCc,
      bcc: mergedBcc,
      status: 'draft',
      created_at: sqliteTimestampToRFC3339(currentRow.created_at),
      updated_at: newWire,
    },
  });

  const auditEventId = deps.ids.uuid();
  const idempotencyRecordId = deps.ids.uuid();
  const requestId = input.requestId ?? null;

  // Fixed batch order: conditional UPDATE -> request marker -> recipients -> audit.
  // changes() gates this request's marker; later writes check its primary key.
  // Concurrent writers can calculate the same timestamp, so that timestamp
  // alone is never a sufficient side-effect guard.
  const statements: D1PreparedStatement[] = [
    deps.db
      .prepare(
        `UPDATE messages
              SET subject   = COALESCE(?, subject),
                  text_body = COALESCE(?, text_body),
                  html_body = COALESCE(?, html_body),
                  updated_at = ?
            WHERE id = ?
              AND status = 'draft'
              AND updated_at = ?`,
      )
      .bind(
        body.subject ?? null,
        body.body_text ?? null,
        body.body_html ?? null,
        newSqlite,
        draftId,
        ifMatchSqlite,
      ),

    deps.db
      .prepare(
        `INSERT INTO idempotency_records
             (id, actor_id, operation, idempotency_key, request_hash,
              response_status, response_json, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, 200, ?, ?, datetime(?, '+${IDEMPOTENCY_TTL_HOURS} hours')
            WHERE changes() > 0
              AND EXISTS (
                SELECT 1 FROM messages
                 WHERE id = ? AND updated_at = ?
              )`,
      )
      .bind(
        idempotencyRecordId,
        userId,
        PATCH_DRAFT_OPERATION,
        idempotencyKey,
        requestHash,
        responseBody,
        newSqlite,
        newSqlite,
        draftId,
        newSqlite,
      ),
  ];

  if (body.to !== undefined) {
    statements.push(
      deps.db
        .prepare(
          `DELETE FROM message_recipients
              WHERE message_id = ?
                AND type = 'to'
                AND EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
        )
        .bind(draftId, idempotencyRecordId),
    );
    for (const address of body.to) {
      statements.push(
        deps.db
          .prepare(
            `INSERT INTO message_recipients
                 (id, message_id, address, display_name, type, created_at)
               SELECT ?, ?, ?, '', 'to', ?
                WHERE EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
          )
          .bind(deps.ids.uuid(), draftId, address, newSqlite, idempotencyRecordId),
      );
    }
  }
  if (body.cc !== undefined) {
    statements.push(
      deps.db
        .prepare(
          `DELETE FROM message_recipients
              WHERE message_id = ?
                AND type = 'cc'
                AND EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
        )
        .bind(draftId, idempotencyRecordId),
    );
    for (const address of body.cc) {
      statements.push(
        deps.db
          .prepare(
            `INSERT INTO message_recipients
                 (id, message_id, address, display_name, type, created_at)
               SELECT ?, ?, ?, '', 'cc', ?
                WHERE EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
          )
          .bind(deps.ids.uuid(), draftId, address, newSqlite, idempotencyRecordId),
      );
    }
  }
  if (body.bcc !== undefined) {
    statements.push(
      deps.db
        .prepare(
          `DELETE FROM message_recipients
              WHERE message_id = ?
                AND type = 'bcc'
                AND EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
        )
        .bind(draftId, idempotencyRecordId),
    );
    for (const address of body.bcc) {
      statements.push(
        deps.db
          .prepare(
            `INSERT INTO message_recipients
                 (id, message_id, address, display_name, type, created_at)
               SELECT ?, ?, ?, '', 'bcc', ?
                WHERE EXISTS (
                  SELECT 1 FROM idempotency_records
                   WHERE id = ?
                )`,
          )
          .bind(deps.ids.uuid(), draftId, address, newSqlite, idempotencyRecordId),
      );
    }
  }

  statements.push(
    prepareOperationAudit(
      deps.auditEventWriter,
      {
        id: auditEventId,
        actorUserId: userId,
        action: 'draft.updated',
        resourceType: 'message',
        resourceId: draftId,
        requestId,
        createdAt: newSqlite,
      },
      { idempotencyMarkerId: idempotencyRecordId },
    ),
  );

  let results: D1Result[];
  try {
    results = await deps.db.batch(statements);
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) {
      return replayOperationAfterRace(
        deps.db,
        userId,
        PATCH_DRAFT_OPERATION,
        idempotencyKey,
        requestHash,
      );
    }
    throw error;
  }

  const updateChanges = results[0]?.meta?.changes ?? 0;
  if (updateChanges === 0) {
    const winnerRecord = await findIdempotencyRecord(
      deps.db,
      userId,
      PATCH_DRAFT_OPERATION,
      idempotencyKey,
    );
    if (winnerRecord) {
      assertSameRequestHash(winnerRecord, requestHash);
      return replayOperation(winnerRecord);
    }

    throw new DomainError({
      code: 'STALE_IF_MATCH',
      message: 'If-Match header does not match the current updated_at',
      httpStatus: 412,
    });
  }

  return operationResult(responseBody, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
