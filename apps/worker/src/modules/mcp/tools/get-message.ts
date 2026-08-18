import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { redactText, wrapUntrustedEmail } from "../pii";
import type { ReadToolDef } from "./_shared";

/**
 * Input schema for `get_message`. The `format` knob lets the caller pick
 * between `minimal` (id + headers + from/subject), `full` (everything
 * except raw mime), and `raw` (raw mime if available). PR #3 only
 * implements `minimal` and `full`; `raw` lands with the attachments PR.
 *
 * A 50 MiB size cap mirrors the Wh1isper convention cited in the impl
 * doc §4.2 — the cap is enforced before any DB read so a request can
 * never trigger a heavy query just to fail at the tail end.
 */
export const GetMessageInputSchema = z.object({
  message_id: z.string().min(1),
  format: z.enum(["full", "minimal", "raw"]).default("full"),
});

export type GetMessageInput = z.infer<typeof GetMessageInputSchema>;

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

const GET_MESSAGE_TOOL = {
  name: "get_message",
  description:
    "Fetch a single message by id with PII redaction applied. The body is wrapped " +
    "in untrusted-email sentinels and capped at 50 MiB.",
  inputSchema: {
    type: "object",
    properties: {
      message_id: {
        type: "string",
        description: "Message ULID.",
      },
      format: {
        type: "string",
        enum: ["full", "minimal", "raw"],
        description: "Output format; defaults to 'full'.",
      },
    },
    additionalProperties: false,
  },
} as const;

interface GetMessageRow {
  id: string;
  thread_id: string | null;
  from_address: string;
  from_name: string;
  subject: string;
  html_body: string;
  text_body: string;
  message_id_header: string | null;
  in_reply_to_header: string | null;
  references_header: string;
  status: string;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
}

interface RecipientRow {
  type: "to" | "cc" | "bcc";
  address: string;
  display_name: string;
}

interface AttachmentMetaRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  disposition: "attachment" | "inline";
}

async function runGetMessage(
  ctx: McpToolContext,
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsedInput = GetMessageInputSchema.safeParse(rawArgs);
  if (!parsedInput.success) {
    throw new McpToolError(
      "invalid_args",
      undefined,
      parsedInput.error.flatten(),
    );
  }
  const input = parsedInput.data;

  // Find a mailbox link the principal can read, then enforce the size cap.
  const link = await ctx.env.DB.prepare(
    `SELECT mm.id AS mailbox_message_id, mm.mailbox_id,
            LENGTH(m.html_body) AS html_len,
            LENGTH(m.text_body) AS text_len
     FROM mailbox_messages mm
     JOIN mailboxes mb ON mb.id = mm.mailbox_id
     LEFT JOIN mailbox_members member
       ON member.mailbox_id = mb.id AND member.user_id = ?
     JOIN messages m ON m.id = mm.message_id
     WHERE mm.message_id = ?
       AND (mb.owner_user_id = ? OR member.user_id = ?)
     ORDER BY CASE WHEN mb.owner_user_id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(
      ctx.principal.userId,
      input.message_id,
      ctx.principal.userId,
      ctx.principal.userId,
      ctx.principal.userId,
    )
    .first<{
      mailbox_message_id: string;
      mailbox_id: string;
      html_len: number;
      text_len: number;
    }>();
  if (!link) {
    throw new McpToolError("not_found", "Message not found");
  }
  if (link.html_len + link.text_len > MAX_PAYLOAD_BYTES) {
    throw new McpToolError(
      "invalid_args",
      `Message payload exceeds the 50 MiB cap`,
    );
  }

  const message = await ctx.env.DB.prepare(
    `SELECT id, thread_id, from_address, from_name, subject, html_body,
            text_body, message_id_header, in_reply_to_header,
            references_header, status, sent_at, received_at, created_at
     FROM messages WHERE id = ?`,
  )
    .bind(input.message_id)
    .first<GetMessageRow>();
  if (!message) {
    throw new McpToolError("not_found", "Message not found");
  }
  const recipients = await ctx.env.DB.prepare(
    `SELECT type, address, display_name
     FROM message_recipients WHERE message_id = ? ORDER BY rowid`,
  )
    .bind(input.message_id)
    .all<RecipientRow>();

  if (input.format === "raw") {
    throw new McpToolError(
      "invalid_args",
      "format=raw is not yet implemented; use 'full' or 'minimal'",
    );
  }
  const minimal = input.format === "minimal";
  const redactedFrom = redactText(message.from_address);
  const redactedSubject = redactText(message.subject);
  const redactedText = redactText(message.text_body);
  const redactedHtml = minimal ? undefined : redactText(message.html_body);
  const wrappedBody = minimal ? undefined : wrapUntrustedEmail(redactedText);

  const attachments = await ctx.env.DB.prepare(
    `SELECT id, filename, mime_type, size_bytes, disposition
     FROM message_attachments WHERE message_id = ?`,
  )
    .bind(input.message_id)
    .all<AttachmentMetaRow>();
  // Attachments: redact the filename (often carries PII / customer IDs) and
  // drop raw bytes — binary payloads never belong in a tool response.
  const redactedAttachments = attachments.results.map((a) => ({
    id: a.id,
    filename: redactText(a.filename),
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    disposition: a.disposition,
  }));

  const headers = {
    message_id_header: message.message_id_header,
    in_reply_to_header: message.in_reply_to_header,
    references_header: message.references_header,
  };
  const groupRecipients = (kind: "to" | "cc" | "bcc") =>
    recipients.results
      .filter((row) => row.type === kind)
      .map((row) => ({
        address: redactText(row.address),
        name: redactText(row.display_name),
      }));

  const payload: Record<string, unknown> = {
    id: message.id,
    headers,
    from: redactedFrom,
    from_name: redactText(message.from_name),
    subject: redactedSubject,
    to: groupRecipients("to"),
    cc: groupRecipients("cc"),
    bcc: groupRecipients("bcc"),
    attachments: redactedAttachments,
    received_at: message.received_at ?? message.sent_at ?? message.created_at,
  };
  if (!minimal) {
    payload.text_body = redactedText;
    payload.text_body_wrapped = wrappedBody;
    if (redactedHtml !== undefined) {
      payload.html_body = redactedHtml;
    }
  }
  if (minimal) {
    // Drop unused buckets so minimal responses stay small.
    delete payload.cc;
    delete payload.bcc;
  }
  return payload;
}

export function getMessageTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: GET_MESSAGE_TOOL.name,
    description: GET_MESSAGE_TOOL.description,
    inputSchema: GET_MESSAGE_TOOL.inputSchema as ReadToolDef["inputSchema"],
    handler: async (args) => {
      const result = await runGetMessage(ctx, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}
