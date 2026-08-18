import { DomainError } from "@unimailbox/contracts";
import PostalMime, { type Address, type Attachment } from "postal-mime";
import type { AppContext } from "../../app-context";
import {
  deleteAttachmentFileIfUnreferenced,
  storeAttachmentFile,
} from "../attachments/file-catalog";

interface InboundSettings {
  inbound_enabled: number;
  unknown_recipient_policy: "reject" | "store";
  sender_blocklist_json: string;
  subject_blocklist_json: string;
  content_blocklist_json: string;
}

interface MailboxRow {
  id: string;
  domain_id: string;
  owner_user_id: string;
}

function mailboxAddress(address: Address | undefined): {
  address: string;
  name: string;
} {
  if (!address || "group" in address) {
    return { address: "unknown@invalid", name: "" };
  }
  return {
    address: address.address.toLowerCase(),
    name: address.name ?? "",
  };
}

function stringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function blocked(value: string, patterns: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return patterns.some((pattern) =>
    normalized.includes(pattern.trim().toLowerCase()),
  );
}

function attachmentBytes(attachment: Attachment): Uint8Array {
  if (typeof attachment.content === "string") {
    return new TextEncoder().encode(attachment.content);
  }
  return attachment.content instanceof ArrayBuffer
    ? new Uint8Array(attachment.content)
    : attachment.content;
}

export class InboundMailService {
  constructor(private readonly context: AppContext) {}

  async receive(message: ForwardableEmailMessage): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 20,
      maxHeadersSize: 256 * 1024,
    });
    const settings = await this.context.env.DB.prepare(
      `SELECT inbound_enabled, unknown_recipient_policy,
              sender_blocklist_json, subject_blocklist_json,
              content_blocklist_json
       FROM system_settings WHERE id = 1`,
    ).first<InboundSettings>();
    if (!settings || settings.inbound_enabled !== 1) {
      message.setReject("421 Inbound mail is temporarily disabled");
      return;
    }

    const sender = mailboxAddress(parsed.from);
    if (
      blocked(sender.address, stringList(settings.sender_blocklist_json)) ||
      blocked(
        parsed.subject ?? "",
        stringList(settings.subject_blocklist_json),
      ) ||
      blocked(
        `${parsed.text ?? ""}\n${parsed.html ?? ""}`,
        stringList(settings.content_blocklist_json),
      )
    ) {
      message.setReject("550 Message rejected by policy");
      return;
    }

    const recipient = message.to.trim().toLowerCase();
    const mailbox = await this.context.env.DB.prepare(
      `SELECT id, domain_id, owner_user_id
       FROM mailboxes
       WHERE address = ? COLLATE NOCASE AND status = 'active'`,
    )
      .bind(recipient)
      .first<MailboxRow>();
    if (!mailbox && settings.unknown_recipient_policy === "reject") {
      message.setReject("550 Unknown recipient");
      return;
    }

    const messageId = crypto.randomUUID();
    const rawObjectKey = `raw/${messageId}.eml`;
    const uploadedKeys: string[] = [rawObjectKey];
    const attachmentFileIds: string[] = [];
    await this.context.attachmentStore.put(rawObjectKey, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { source: "inbound", messageId },
    });

    const attachmentRows: Array<{
      id: string;
      objectKey: string;
      filename: string | null;
      mimeType: string;
      size: number;
      disposition: "attachment" | "inline";
      contentId: string | null;
      fileId: string;
      md5: string;
    }> = [];
    try {
      for (const attachment of parsed.attachments) {
        const id = crypto.randomUUID();
        const objectKey = `attachments/${id}`;
        const bytes = attachmentBytes(attachment);
        const file = await storeAttachmentFile(this.context, {
          objectKey,
          body: bytes,
          sizeBytes: bytes.byteLength,
          metadata: {
            httpMetadata: { contentType: attachment.mimeType },
            customMetadata: {
              filename: attachment.filename ?? "",
              disposition: attachment.disposition ?? "attachment",
            },
          },
        });
        attachmentFileIds.push(file.fileId);
        attachmentRows.push({
          id,
          objectKey: file.objectKey,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: bytes.byteLength,
          disposition:
            attachment.disposition === "inline" ? "inline" : "attachment",
          contentId: attachment.contentId ?? null,
          fileId: file.fileId,
          md5: file.md5,
        });
      }

      const mailboxMessageId = mailbox ? crypto.randomUUID() : null;
      const recipientRows = [
        ...(parsed.to ?? []).flatMap((value) =>
          value.group
            ? value.group.map((item) => ({
                type: "to",
                address: item.address,
                name: item.name,
              }))
            : [{ type: "to", address: value.address, name: value.name }],
        ),
        ...(parsed.cc ?? []).flatMap((value) =>
          value.group
            ? value.group.map((item) => ({
                type: "cc",
                address: item.address,
                name: item.name,
              }))
            : [{ type: "cc", address: value.address, name: value.name }],
        ),
      ];
      const statements: D1PreparedStatement[] = [
        this.context.env.DB.prepare(
          `INSERT INTO messages (
             id, domain_id, thread_id, from_address, from_name, subject, html_body,
             text_body, message_id_header, in_reply_to_header,
             references_header, status, raw_object_key, received_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, CURRENT_TIMESTAMP)`,
        ).bind(
          messageId,
          mailbox?.domain_id ?? null,
          parsed.inReplyTo ?? parsed.messageId ?? messageId,
          sender.address,
          sender.name,
          parsed.subject ?? "",
          parsed.html ?? "",
          parsed.text ?? "",
          parsed.messageId ?? null,
          parsed.inReplyTo ?? null,
          parsed.references ?? "",
          rawObjectKey,
        ),
        ...recipientRows.map((item) =>
          this.context.env.DB.prepare(
            `INSERT INTO message_recipients (
               id, message_id, type, address, display_name
             ) VALUES (?, ?, ?, ?, ?)`,
          ).bind(
            crypto.randomUUID(),
            messageId,
            item.type,
            item.address.toLowerCase(),
            item.name ?? "",
          ),
        ),
        ...(mailbox && mailboxMessageId
          ? [
              this.context.env.DB.prepare(
                `INSERT INTO mailbox_messages (
                   id, mailbox_id, message_id, folder
                 ) VALUES (?, ?, ?, 'inbox')`,
              ).bind(mailboxMessageId, mailbox.id, messageId),
              this.context.env.DB.prepare(
                `INSERT INTO message_user_state (
                   mailbox_message_id, user_id, is_read, is_starred
                 ) VALUES (?, ?, 0, 0)`,
              ).bind(mailboxMessageId, mailbox.owner_user_id),
            ]
          : []),
        ...attachmentRows.map((item) =>
          this.context.env.DB.prepare(
            `INSERT INTO message_attachments (
               id, message_id, object_key, filename, mime_type, size_bytes,
               disposition, content_id, file_id, md5
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            messageId,
            item.objectKey,
            item.filename,
            item.mimeType,
            item.size,
            item.disposition,
            item.contentId,
            item.fileId,
            item.md5,
          ),
        ),
        this.context.env.DB.prepare(
          `INSERT INTO audit_events (
             id, action, resource_type, resource_id, request_id, metadata_json
           ) VALUES (?, 'inbound.message.received', 'message', ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          messageId,
          crypto.randomUUID(),
          JSON.stringify({
            mailboxId: mailbox?.id ?? null,
            originalRecipient: recipient,
            unknownRecipient: !mailbox,
            attachmentCount: attachmentRows.length,
          }),
        ),
      ];
      await this.context.env.DB.batch(statements);
      this.context.logger.info("inbound.message.accepted", {
        messageId,
        mailboxId: mailbox?.id ?? null,
        unknownRecipient: !mailbox,
        attachmentCount: attachmentRows.length,
      });
      if (mailbox) {
        this.context.env.INBOX_INDEX_QUEUE?.send({
          mailbox_id: mailbox.id,
          message_id: messageId,
        }).catch(() => undefined);
      }
    } catch (error) {
      for (const fileId of attachmentFileIds) {
        await deleteAttachmentFileIfUnreferenced(this.context, fileId);
      }
      await this.context.env.OUTBOUND_QUEUE.send({
        kind: "orphan_object_cleanup",
        jobId: `orphan-cleanup:${crypto.randomUUID()}`,
        objectKeys: uploadedKeys,
      });
      this.context.logger.error("inbound.message.failed", {
        messageId,
        uploadedObjectCount: uploadedKeys.length,
        error: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
      });
      throw error;
    }
  }
}
