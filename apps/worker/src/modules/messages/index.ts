import {
  DomainError,
  type MailboxFolder,
  type Principal,
  type SendMessageInput,
} from "@unimailbox/contracts";
import {
  buildReplyHeaders,
  canonicalRequestHashInput,
  composeSignature,
  normalizeRecipients,
} from "@unimailbox/email-core";
import type { AppContext } from "../../app-context";
import { OutboundJobService } from "../outbound-mail";
import type { MailboxApplicationService } from "../mailboxes";
import { enforceRateLimit, rateLimitRules } from "../../platform/rate-limit";
import type { CursorCodec } from "./cursor";

interface SenderMailboxRow {
  id: string;
  domain_id: string;
  owner_user_id: string;
  address: string;
  display_name: string;
  domain_name: string;
  outbound_connection_id: string | null;
}

interface InternalRecipientRow {
  id: string;
  address: string;
}

interface UploadRow {
  id: string;
  object_key: string;
  file_id: string;
  md5: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  disposition: "attachment" | "inline";
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function values(count: number, width: number): string {
  return Array.from(
    { length: count },
    () => `(${Array.from({ length: width }, () => "?").join(",")})`,
  ).join(",");
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

export class MessageApplicationService {
  constructor(
    private readonly context: Pick<
      AppContext,
      "env" | "providers" | "credentials" | "logger" | "attachmentStore"
    >,
    private readonly mailboxes: MailboxApplicationService,
    private readonly cursors: CursorCodec,
  ) {}

  async send(
    principal: Principal,
    input: SendMessageInput,
    idempotencyKey: string,
  ): Promise<{ messageId: string; status: "queued" | "sent" }> {
    if (!principal.permissions.has("message.send")) {
      throw new DomainError(
        "PERMISSION_DENIED",
        "Permission message.send is required",
        403,
      );
    }
    if (!idempotencyKey.trim() || idempotencyKey.length > 255) {
      throw new DomainError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key header is required",
      );
    }
    await enforceRateLimit(
      this.context.env.KV,
      rateLimitRules.messageSend,
      principal.userId,
    );
    // The canonical hash serialises the input with sorted object keys, so
    // JSON field order differences across callers don't cause replay
    // mismatches against the recorded idempotency record.
    const requestHash = await sha256(canonicalRequestHashInput(input));
    const replay = await this.findIdempotency(principal.userId, idempotencyKey);
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was used with different input",
          409,
        );
      }
      return JSON.parse(replay.response_json) as {
        messageId: string;
        status: "queued" | "sent";
      };
    }

    await this.mailboxes.assert(principal.userId, input.mailboxId, "send");
    const sender = await this.context.env.DB.prepare(
      `SELECT m.id, m.domain_id, m.owner_user_id, m.address, m.display_name,
              d.name AS domain_name, d.outbound_connection_id
       FROM mailboxes m
       JOIN domains d ON d.id = m.domain_id
       WHERE m.id = ? AND m.status = 'active' AND d.status = 'active'`,
    )
      .bind(input.mailboxId)
      .first<SenderMailboxRow>();
    if (!sender) {
      throw new DomainError(
        "SENDER_MAILBOX_INACTIVE",
        "The sender mailbox or domain is not active",
        409,
      );
    }
    const recipients = normalizeRecipients(input.to, input.cc, input.bcc);
    const allAddresses = [
      ...recipients.to,
      ...recipients.cc,
      ...recipients.bcc,
    ];
    const internalResult =
      allAddresses.length === 0
        ? { results: [] as InternalRecipientRow[] }
        : await this.context.env.DB.prepare(
            `SELECT id, address FROM mailboxes
             WHERE status = 'active' AND address IN (${placeholders(allAddresses.length)})`,
          )
            .bind(...allAddresses)
            .all<InternalRecipientRow>();
    const internalByAddress = new Map(
      internalResult.results.map((row) => [row.address.toLowerCase(), row]),
    );
    const external = allAddresses.filter(
      (address) => !internalByAddress.has(address),
    );
    if (external.length > 0 && !sender.outbound_connection_id) {
      throw new DomainError(
        "OUTBOUND_PROVIDER_NOT_CONFIGURED",
        "The sender domain has no outbound provider connection",
        409,
      );
    }
    if (sender.outbound_connection_id) {
      const connection = await this.context.env.DB.prepare(
        `SELECT status FROM provider_connections WHERE id = ?`,
      )
        .bind(sender.outbound_connection_id)
        .first<{ status: string }>();
      if (external.length > 0 && connection?.status !== "active") {
        throw new DomainError(
          "PROVIDER_CONNECTION_INACTIVE",
          "The outbound provider connection is not active",
          409,
        );
      }
    }

    const uploads =
      input.attachmentIds.length === 0
        ? { results: [] as UploadRow[] }
        : await this.context.env.DB.prepare(
            `SELECT au.id, af.object_key, au.file_id, au.md5, au.filename,
                    au.mime_type, au.size_bytes, au.disposition
             FROM attachment_uploads au
             JOIN attachment_files af ON af.id = au.file_id
             WHERE au.user_id = ? AND au.status = 'uploaded'
               AND au.md5 IS NOT NULL
               AND au.expires_at > CURRENT_TIMESTAMP
               AND au.id IN (${placeholders(input.attachmentIds.length)})`,
          )
            .bind(principal.userId, ...input.attachmentIds)
            .all<UploadRow>();
    // Compare the *unique* requested ids so duplicate references in the
    // request body don't trip the validity check.
    const uniqueRequestedAttachmentCount = new Set(input.attachmentIds).size;
    if (uploads.results.length !== uniqueRequestedAttachmentCount) {
      throw new DomainError(
        "ATTACHMENT_UPLOAD_INVALID",
        "One or more attachment uploads are unavailable",
        409,
      );
    }

    let html = input.html;
    let text = input.text;
    if (input.includeSignature) {
      const signature = await this.context.env.DB.prepare(
        `SELECT html_content, text_content
         FROM domain_signatures
         WHERE domain_id = ? AND is_enabled = 1`,
      )
        .bind(sender.domain_id)
        .first<{ html_content: string; text_content: string }>();
      if (signature) {
        html = composeSignature({
          body: html,
          signature: signature.html_content,
          format: "html",
        });
        text = composeSignature({
          body: text,
          signature: signature.text_content,
          format: "text",
        });
      }
    }
    let inReplyTo: string | null = null;
    let references = "";
    let threadId: string | null = null;
    if (input.parentMessageId) {
      const parent = await this.context.env.DB.prepare(
        `SELECT m.message_id_header, m.references_header,
                COALESCE(m.thread_id, m.id) AS thread_id
         FROM messages m
         JOIN mailbox_messages mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
         LEFT JOIN mailbox_members member
           ON member.mailbox_id = mb.id AND member.user_id = ?
         WHERE m.id = ? AND (mb.owner_user_id = ? OR member.user_id = ?)
         LIMIT 1`,
      )
        .bind(
          principal.userId,
          input.parentMessageId,
          principal.userId,
          principal.userId,
        )
        .first<{
          message_id_header: string | null;
          references_header: string;
          thread_id: string;
        }>();
      if (!parent) {
        throw new DomainError(
          "PARENT_MESSAGE_NOT_FOUND",
          "The parent message is unavailable",
          404,
        );
      }
      if (parent.message_id_header) {
        const headers = buildReplyHeaders({
          parentMessageId: parent.message_id_header,
          parentReferences: parent.references_header,
        });
        inReplyTo = headers.inReplyTo;
        references = headers.references;
      }
      threadId = parent.thread_id;
    }

    const messageId = crypto.randomUUID();
    const providerJobId = external.length > 0 ? crypto.randomUUID() : null;
    const status = providerJobId ? "queued" : "sent";
    const response = { messageId, status } as const;
    const messageIdHeader = `<${messageId}@${sender.domain_name}>`;
    const recipientEntries = [
      ...recipients.to.map((address) => ({ type: "to", address })),
      ...recipients.cc.map((address) => ({ type: "cc", address })),
      ...recipients.bcc.map((address) => ({ type: "bcc", address })),
    ];
    const internalMailboxes = [
      ...new Map(
        allAddresses
          .map((address) => internalByAddress.get(address))
          .filter((row): row is InternalRecipientRow => row !== undefined)
          .map((row) => [row.id, row]),
      ).values(),
    ];
    const statements: D1PreparedStatement[] = [
      this.context.env.DB.prepare(
        `INSERT INTO messages (
           id, domain_id, thread_id, from_address, from_name, subject, html_body, text_body,
           message_id_header, in_reply_to_header, references_header,
           provider_connection_id, status, created_by_user_id, sent_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      ).bind(
        messageId,
        sender.domain_id,
        threadId ?? messageId,
        sender.address,
        sender.display_name,
        input.subject,
        html,
        text,
        messageIdHeader,
        inReplyTo,
        references,
        providerJobId ? sender.outbound_connection_id : null,
        status,
        principal.userId,
        status,
      ),
      this.context.env.DB.prepare(
        `INSERT INTO message_recipients (
           id, message_id, type, address, display_name
         ) VALUES ${values(recipientEntries.length, 5)}`,
      ).bind(
        ...recipientEntries.flatMap((recipient) => [
          crypto.randomUUID(),
          messageId,
          recipient.type,
          recipient.address,
          "",
        ]),
      ),
      this.context.env.DB.prepare(
        `INSERT INTO mailbox_messages (id, mailbox_id, message_id, folder)
         VALUES (?, ?, ?, 'sent')`,
      ).bind(crypto.randomUUID(), sender.id, messageId),
      ...(internalMailboxes.length > 0
        ? [
            this.context.env.DB.prepare(
              `INSERT INTO mailbox_messages (
                 id, mailbox_id, message_id, folder
               ) VALUES ${values(internalMailboxes.length, 4)}`,
            ).bind(
              ...internalMailboxes.flatMap((mailbox) => [
                crypto.randomUUID(),
                mailbox.id,
                messageId,
                "inbox",
              ]),
            ),
          ]
        : []),
      ...(uploads.results.length > 0
        ? [
            this.context.env.DB.prepare(
              `INSERT INTO message_attachments (
                 id, message_id, upload_id, object_key, filename, mime_type,
                 size_bytes, disposition, file_id, md5
               ) VALUES ${values(uploads.results.length, 10)}`,
            ).bind(
              ...uploads.results.flatMap((upload) => [
                crypto.randomUUID(),
                messageId,
                upload.id,
                upload.object_key,
                upload.filename,
                upload.mime_type,
                upload.size_bytes,
                upload.disposition,
                upload.file_id,
                upload.md5,
              ]),
            ),
          ]
        : []),
      ...(providerJobId
        ? [
            this.context.env.DB.prepare(
              `INSERT INTO outbound_jobs (id, message_id, status, created_via_schedule)
               VALUES (?, ?, 'pending', 0)`,
            ).bind(providerJobId, messageId),
          ]
        : []),
      this.context.env.DB.prepare(
        `INSERT INTO idempotency_records (
           id, actor_user_id, operation, idempotency_key, request_hash,
           resource_id, response_status, response_json, expires_at
         ) VALUES (?, ?, 'message.send', ?, ?, ?, 201, ?,
                   datetime('now', '+1 day'))`,
      ).bind(
        crypto.randomUUID(),
        principal.userId,
        idempotencyKey,
        requestHash,
        messageId,
        JSON.stringify(response),
      ),
    ];
    try {
      await this.context.env.DB.batch(statements);
    } catch (error) {
      const afterConflict = await this.findIdempotency(
        principal.userId,
        idempotencyKey,
      );
      if (!afterConflict) throw error;
      if (afterConflict.request_hash !== requestHash) {
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was used with different input",
          409,
        );
      }
      return JSON.parse(afterConflict.response_json) as typeof response;
    }
    this.context.env.INBOX_INDEX_QUEUE?.send({
      mailbox_id: sender.id,
      message_id: messageId,
    }).catch(() => undefined);
    if (providerJobId) {
      try {
        await new OutboundJobService(this.context).dispatch(providerJobId);
      } catch {
        this.context.logger.warn("outbound.dispatch.deferred", {
          jobId: providerJobId,
          messageId,
        });
      }
    }
    return response;
  }

  async list(
    principal: Principal,
    mailboxId: string,
    input: {
      folder: MailboxFolder;
      cursor?: string;
      limit: number;
      starred?: boolean;
    },
  ) {
    await this.mailboxes.assert(principal.userId, mailboxId, "read");
    const cursor = input.cursor
      ? await this.cursors.decode(input.cursor)
      : null;
    const result = await this.context.env.DB.prepare(
      `SELECT mm.id AS mailbox_message_id, m.id, m.from_address, m.from_name,
              m.subject, m.status, m.created_at, m.sent_at, m.received_at,
              COALESCE(mus.is_read, 0) AS is_read,
              COALESCE(mus.is_starred, 0) AS is_starred
       FROM mailbox_messages mm
       JOIN messages m ON m.id = mm.message_id
       LEFT JOIN message_user_state mus
         ON mus.mailbox_message_id = mm.id AND mus.user_id = ?
       WHERE mm.mailbox_id = ? AND mm.folder = ?
         AND mus.deleted_at IS NULL
         AND (? IS NULL OR COALESCE(mus.is_starred, 0) = ?)
         AND (
           ? IS NULL OR m.created_at < ?
           OR (m.created_at = ? AND m.id < ?)
         )
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    )
      .bind(
        principal.userId,
        mailboxId,
        input.folder,
        input.starred === undefined ? null : Number(input.starred),
        input.starred === undefined ? null : Number(input.starred),
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        input.limit + 1,
      )
      .all<Record<string, unknown> & { id: string; created_at: string }>();
    const hasNext = result.results.length > input.limit;
    const items = result.results.slice(0, input.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasNext && last
          ? await this.cursors.encode({
              createdAt: last.created_at,
              id: last.id,
            })
          : null,
    };
  }

  async get(principal: Principal, messageId: string) {
    const link = await this.requireReadableLink(principal, messageId);
    const message = await this.context.env.DB.prepare(
      `SELECT id, thread_id, from_address, from_name, subject, html_body,
              text_body, message_id_header, in_reply_to_header,
              references_header, status, sent_at, received_at, created_at,
              updated_at
       FROM messages WHERE id = ?`,
    )
      .bind(messageId)
      .first();
    const recipients = await this.context.env.DB.prepare(
      `SELECT type, address, display_name
       FROM message_recipients WHERE message_id = ? ORDER BY rowid`,
    )
      .bind(messageId)
      .all();
    return {
      ...message,
      mailboxMessageId: link.id,
      mailboxId: link.mailbox_id,
      recipients: recipients.results,
    };
  }

  async setRead(
    principal: Principal,
    messageId: string,
    isRead: boolean,
  ): Promise<void> {
    await this.mutateState(principal, messageId, "is_read", isRead);
  }

  async setStarred(
    principal: Principal,
    messageId: string,
    isStarred: boolean,
  ): Promise<void> {
    await this.mutateState(principal, messageId, "is_starred", isStarred);
  }

  async move(
    principal: Principal,
    messageId: string,
    mailboxId: string,
    folder: "inbox" | "archive" | "trash",
  ): Promise<void> {
    if (!principal.permissions.has("message.delete")) {
      throw new DomainError(
        "PERMISSION_DENIED",
        "Permission message.delete is required",
        403,
      );
    }
    await this.mailboxes.assert(principal.userId, mailboxId, "delete_message");
    const result = await this.context.env.DB.prepare(
      `UPDATE mailbox_messages
       SET folder = ?, updated_at = CURRENT_TIMESTAMP
       WHERE mailbox_id = ? AND message_id = ?`,
    )
      .bind(folder, mailboxId, messageId)
      .run();
    if (result.meta.changes !== 1) {
      throw new DomainError(
        "MESSAGE_NOT_FOUND",
        "Message not found in this mailbox",
        404,
      );
    }
  }

  async remove(principal: Principal, messageId: string): Promise<void> {
    const link = await this.requireReadableLink(principal, messageId);
    await this.context.env.DB.prepare(
      `INSERT INTO message_user_state (
         mailbox_message_id, user_id, is_read, is_starred, deleted_at
       ) VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP)
       ON CONFLICT(mailbox_message_id, user_id) DO UPDATE
       SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(link.id, principal.userId)
      .run();
  }

  async listAttachments(principal: Principal, messageId: string) {
    await this.requireReadableLink(principal, messageId);
    const result = await this.context.env.DB.prepare(
      `SELECT id, filename, mime_type, size_bytes, disposition, content_id
       FROM message_attachments WHERE message_id = ?`,
    )
      .bind(messageId)
      .all();
    return result.results;
  }

  private async findIdempotency(
    userId: string,
    key: string,
  ): Promise<IdempotencyRow | null> {
    return this.context.env.DB.prepare(
      `SELECT request_hash, response_json
       FROM idempotency_records
       WHERE actor_user_id = ? AND operation = 'message.send'
         AND idempotency_key = ? AND expires_at > CURRENT_TIMESTAMP`,
    )
      .bind(userId, key)
      .first<IdempotencyRow>();
  }

  private async requireReadableLink(
    principal: Principal,
    messageId: string,
  ): Promise<{ id: string; mailbox_id: string }> {
    const link = await this.context.env.DB.prepare(
      `SELECT mm.id, mm.mailbox_id
       FROM mailbox_messages mm
       JOIN mailboxes mb ON mb.id = mm.mailbox_id
       LEFT JOIN mailbox_members member
         ON member.mailbox_id = mb.id AND member.user_id = ?
       WHERE mm.message_id = ?
         AND (mb.owner_user_id = ? OR member.user_id = ?)
       ORDER BY CASE WHEN mb.owner_user_id = ? THEN 0 ELSE 1 END
       LIMIT 1`,
    )
      .bind(
        principal.userId,
        messageId,
        principal.userId,
        principal.userId,
        principal.userId,
      )
      .first<{ id: string; mailbox_id: string }>();
    if (!link) {
      throw new DomainError("MESSAGE_NOT_FOUND", "Message not found", 404);
    }
    return link;
  }

  private async mutateState(
    principal: Principal,
    messageId: string,
    column: "is_read" | "is_starred",
    value: boolean,
  ): Promise<void> {
    const link = await this.requireReadableLink(principal, messageId);
    await this.context.env.DB.prepare(
      `INSERT INTO message_user_state (
         mailbox_message_id, user_id, is_read, is_starred
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(mailbox_message_id, user_id) DO UPDATE
       SET ${column} = excluded.${column}, updated_at = CURRENT_TIMESTAMP`,
    )
      .bind(
        link.id,
        principal.userId,
        column === "is_read" ? Number(value) : 0,
        column === "is_starred" ? Number(value) : 0,
      )
      .run();
  }
}
