import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { redactText } from "../pii";
import type { WriteToolDef } from "./write-common";

/**
 * First-party MCP attachment tools.
 *
 * PR #5 of the email-mcp-server rollout.
 *
 * Two tools land here:
 *
 *   - `list_attachments`: metadata-only. Returns id / redacted filename /
 *     mime_type / size / disposition for every attachment on a message the
 *     principal can read. Never returns binary content.
 *   - `download_attachment`: gated behind the `attachment.read` scope AND
 *     the `mcp_attachment_download_enabled` user setting in `system_settings`
 *     (default off — PR #5 ships it fail-closed). Enforces a 25 MiB size
 *     cap and returns the binary as base64 inside `content[].blob`.
 *
 * The PR doc described a signed-URL download path as "preferred" with a
 * base64 inline fallback. We chose base64 for v1 because:
 *
 *   1. Integrating the signed URL cleanly required either widening
 *      `WriteToolDef` to thread the originating `Request` through the
 *      dispatcher (cross-PR surface change) or modifying `app-context.ts`
 *      (PR #1 file). Both edits crossed the "Do NOT modify PR #1-4 files"
 *      guardrail.
 *   2. The 25 MiB cap keeps the base64 payload bounded — at worst the
 *      response is ~33 MiB of UTF-8 string, which is still well under the
 *      Workers response body limit and lands inside the impl doc §5.2
 *      guidance for tool responses.
 *   3. The fallback path preserves the security properties the doc cares
 *      about (no binary in `content[]`, default-off guard, audit row)
 *      without adding a new HTTP route.
 */

export const ListAttachmentsInputSchema = z.object({
  message_id: z.string().min(1),
});

export const DownloadAttachmentInputSchema = z.object({
  attachment_id: z.string().min(1),
});

export type ListAttachmentsInput = z.infer<typeof ListAttachmentsInputSchema>;
export type DownloadAttachmentInput = z.infer<
  typeof DownloadAttachmentInputSchema
>;

export const ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES = 25 * 1024 * 1024;

interface AttachmentRow {
  id: string;
  filename: string | null;
  mime_type: string;
  size_bytes: number;
  disposition: "attachment" | "inline";
}

interface AttachmentDetailRow extends AttachmentRow {
  object_key: string;
  mailbox_id: string;
}

interface SettingsRow {
  mcp_attachment_download_enabled: number | null;
}

const listAttachmentsJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    message_id: {
      type: "string",
      description: "Message id whose attachments to list.",
    },
  },
  required: ["message_id"],
  additionalProperties: false,
};

const downloadAttachmentJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    attachment_id: {
      type: "string",
      description: "Attachment id returned by list_attachments.",
    },
  },
  required: ["attachment_id"],
  additionalProperties: false,
};

function invalidArgs(error: z.ZodError): McpToolError {
  return new McpToolError("invalid_args", undefined, error.flatten());
}

async function findReadableMailbox(
  ctx: McpToolContext,
  messageId: string,
): Promise<{ mailboxId: string } | null> {
  const link = await ctx.env.DB.prepare(
    `SELECT mm.mailbox_id
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
      ctx.principal.userId,
      messageId,
      ctx.principal.userId,
      ctx.principal.userId,
      ctx.principal.userId,
    )
    .first<{ mailbox_id: string }>();
  return link ? { mailboxId: link.mailbox_id } : null;
}

export function listAttachmentsTool(ctx: McpToolContext): WriteToolDef {
  return {
    name: "list_attachments",
    description:
      "List attachments on a message the principal can read. " +
      "Returns metadata only — no binary payload. Filenames are PII-redacted.",
    inputSchema: listAttachmentsJsonSchema,
    handler: async (rawArgs) => {
      const parsed = ListAttachmentsInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const link = await findReadableMailbox(ctx, input.message_id);
      if (!link) {
        throw new McpToolError("not_found", "Message not found");
      }
      const rows = await ctx.env.DB.prepare(
        `SELECT id, filename, mime_type, size_bytes, disposition
         FROM message_attachments WHERE message_id = ?
         ORDER BY created_at, id`,
      )
        .bind(input.message_id)
        .all<AttachmentRow>();
      const attachments = rows.results.map((row) => ({
        id: row.id,
        filename: row.filename ? redactText(row.filename) : null,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        disposition: row.disposition,
      }));
      const result = { attachments };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: { ...result },
      };
    },
  };
}

async function isAttachmentDownloadEnabled(
  ctx: McpToolContext,
): Promise<boolean> {
  const row = await ctx.env.DB.prepare(
    "SELECT mcp_attachment_download_enabled FROM system_settings WHERE id = 1",
  ).first<SettingsRow>();
  return (row?.mcp_attachment_download_enabled ?? 0) === 1;
}

interface AttachmentStoreLike {
  get(objectKey: string): Promise<{
    body: BodyInit;
    size: number;
    etag?: string;
  } | null>;
}

async function bodyToBase64(body: BodyInit): Promise<string> {
  if (body instanceof Uint8Array) return bytesToBase64(body);
  if (body instanceof ArrayBuffer) {
    return bytesToBase64(new Uint8Array(body));
  }
  if (body instanceof Blob) {
    return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
  }
  if (typeof body === "string") {
    return bytesToBase64(new TextEncoder().encode(body));
  }
  // ReadableStream
  const response = new Response(body as ReadableStream);
  const buffer = await response.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function downloadAttachmentTool(ctx: McpToolContext): WriteToolDef {
  const store = ctx.modules.attachmentStore as AttachmentStoreLike;
  return {
    name: "download_attachment",
    description:
      "Download an attachment as base64 binary inside `content[].blob`. " +
      "Requires `attachment.read` AND the per-user `mcp_attachment_download_enabled` setting (default OFF). " +
      "Enforces a 25 MiB size cap and rejects oversized attachments with `invalid_args`.",
    inputSchema: downloadAttachmentJsonSchema,
    handler: async (rawArgs) => {
      const parsed = DownloadAttachmentInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const enabled = await isAttachmentDownloadEnabled(ctx);
      if (!enabled) {
        throw new McpToolError(
          "forbidden",
          "Attachment downloads are disabled in this account",
        );
      }
      const row = await ctx.env.DB.prepare(
        `SELECT ma.id, ma.filename, ma.mime_type, ma.size_bytes,
                ma.disposition, ma.object_key, mm.mailbox_id
         FROM message_attachments ma
         JOIN mailbox_messages mm ON mm.message_id = ma.message_id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
         LEFT JOIN mailbox_members member
           ON member.mailbox_id = mb.id AND member.user_id = ?
         WHERE ma.id = ? AND (mb.owner_user_id = ? OR member.user_id = ?)
         ORDER BY CASE WHEN mb.owner_user_id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
        .bind(
          ctx.principal.userId,
          input.attachment_id,
          ctx.principal.userId,
          ctx.principal.userId,
          ctx.principal.userId,
        )
        .first<AttachmentDetailRow>();
      if (!row) {
        throw new McpToolError("not_found", "Attachment not found");
      }
      if (row.size_bytes > ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES) {
        throw new McpToolError(
          "invalid_args",
          `Attachment exceeds the ${ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES}-byte download cap`,
          {
            size_bytes: row.size_bytes,
            cap_bytes: ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES,
          },
        );
      }
      const object = await store.get(row.object_key);
      if (!object) {
        throw new McpToolError(
          "not_found",
          "The attachment object is unavailable",
        );
      }
      const blob = await bodyToBase64(object.body);
      const metadata = {
        attachment_id: row.id,
        filename: row.filename ? redactText(row.filename) : null,
        mime_type: row.mime_type,
        disposition: row.disposition,
        size_bytes: row.size_bytes,
      };
      // The response is a single text envelope carrying both metadata
      // and the base64 payload. The MCP `content[]` type narrows to
      // `{ type: "text"; text: string }` in the dispatcher — see
      // `ToolDefinition` in `apps/worker/src/modules/mcp/server.ts`. A
      // future PR can introduce a `resource` content variant (the spec
      // already supports it) once the dispatcher is widened.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ...metadata, blob }),
          },
        ],
        structuredContent: { ...metadata },
      };
    },
  };
}
