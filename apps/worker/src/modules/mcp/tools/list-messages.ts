import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { redactText } from "../pii";
import type { ReadToolDef } from "./_shared";

/**
 * Input schema for `list_messages`. Mirrors the REST
 * `GET /api/v1/mailboxes/:id/messages` query string, with the additions
 * called out in the impl doc §4.2 (subject, from, since/before, label_id).
 */
export const ListMessagesInputSchema = z.object({
  mailbox_id: z.string().min(1),
  since: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  from: z.string().min(1).max(254).optional(),
  subject: z.string().min(1).max(998).optional(),
  label_id: z
    .enum(["inbox", "sent", "drafts", "archive", "trash"])
    .default("inbox"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

export type ListMessagesInput = z.infer<typeof ListMessagesInputSchema>;

const LIST_MESSAGES_TOOL = {
  name: "list_messages",
  description:
    "List messages in a mailbox with optional from/subject/since/before filters. " +
    "Returns previews (2 KiB cap per item, PII-redacted).",
  inputSchema: {
    type: "object",
    properties: {
      mailbox_id: {
        type: "string",
        description: "Mailbox ULID the principal has read access to.",
      },
      since: {
        type: "string",
        description: "ISO datetime, inclusive lower bound.",
      },
      before: {
        type: "string",
        description: "ISO datetime, exclusive upper bound.",
      },
      from: {
        type: "string",
        description: "Sender address substring (case-insensitive).",
      },
      subject: {
        type: "string",
        description: "Subject substring (case-insensitive).",
      },
      label_id: {
        type: "string",
        description:
          "Folder id (inbox, sent, drafts, archive, trash); defaults to inbox.",
      },
      limit: { type: "number", description: "1-100; defaults to 50." },
      cursor: {
        type: "string",
        description: "Opaque pagination cursor from a prior call.",
      },
    },
    additionalProperties: false,
  },
} as const;

const PREVIEW_BYTES = 2 * 1024;

interface ListMessagesRow {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  text_body: string;
  created_at: string;
  sent_at: string | null;
  received_at: string | null;
}

/**
 * Build the SQL that powers `list_messages`. Pulled out of the handler so
 * unit tests can assert the exact query shape without spinning up D1.
 *
 * The keyset predicate on `(m.created_at, m.id)` is added when the caller
 * passes a cursor; without it the cursor is decorative. The
 * `created_at` / `id` field names MUST match the payload shape that
 * `CursorCodec` decodes (see `apps/worker/src/modules/messages/cursor.ts`).
 */
export async function buildListMessagesQuery(
  ctx: McpToolContext,
  input: ListMessagesInput,
): Promise<{ sql: string; params: unknown[] }> {
  const where: string[] = ["mm.mailbox_id = ?", "mm.folder = ?"];
  const params: unknown[] = [input.mailbox_id, input.label_id];
  if (input.since) {
    where.push("COALESCE(m.received_at, m.sent_at, m.created_at) >= ?");
    params.push(input.since);
  }
  if (input.before) {
    where.push("COALESCE(m.received_at, m.sent_at, m.created_at) < ?");
    params.push(input.before);
  }
  if (input.from) {
    where.push("m.from_address LIKE ? COLLATE NOCASE");
    params.push(`%${input.from}%`);
  }
  if (input.subject) {
    where.push("m.subject LIKE ? COLLATE NOCASE");
    params.push(`%${input.subject}%`);
  }
  if (input.cursor) {
    const decoded = await ctx.modules.cursors.decode(input.cursor);
    where.push("(m.created_at < ? OR (m.created_at = ? AND m.id < ?))");
    params.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }
  const sql = `SELECT m.id, m.from_address, m.from_name, m.subject,
                      m.text_body, m.created_at, m.sent_at, m.received_at
               FROM mailbox_messages mm
               JOIN messages m ON m.id = mm.message_id
               WHERE ${where.join(" AND ")}
               ORDER BY m.created_at DESC, m.id DESC
               LIMIT ?`;
  params.push(input.limit + 1); // +1 to detect next page
  return { sql, params };
}

function clip(text: string): string {
  return text.length <= PREVIEW_BYTES ? text : text.slice(0, PREVIEW_BYTES);
}

async function runListMessages(
  ctx: McpToolContext,
  rawArgs: Record<string, unknown>,
): Promise<{
  messages: Array<{
    id: string;
    from: string;
    subject: string;
    preview: string;
    received_at: string;
  }>;
  next_cursor: string | null;
}> {
  const parsed = ListMessagesInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new McpToolError("invalid_args", undefined, parsed.error.flatten());
  }
  const input = parsed.data;

  // Permission + mailbox access check first, before any data fetch.
  const access = await ctx.modules.mailboxes.findAccess(
    ctx.principal.userId,
    input.mailbox_id,
  );
  if (!access) {
    throw new McpToolError("not_found", "Mailbox not found");
  }
  const { sql, params } = await buildListMessagesQuery(ctx, input);
  const result = await ctx.env.DB.prepare(sql)
    .bind(...params)
    .all<ListMessagesRow>();
  const hasNext = result.results.length > input.limit;
  const items = (
    hasNext ? result.results.slice(0, input.limit) : result.results
  ).map((row) => ({
    id: row.id,
    from: redactText(row.from_address),
    subject: redactText(row.subject),
    preview: redactText(clip(row.text_body)),
    received_at: row.received_at ?? row.sent_at ?? row.created_at,
  }));
  const lastPageRow = hasNext
    ? result.results[input.limit - 1]
    : result.results.at(-1);
  let nextCursor: string | null = null;
  if (hasNext && lastPageRow) {
    nextCursor = await ctx.modules.cursors.encode({
      createdAt: lastPageRow.created_at,
      id: lastPageRow.id,
    });
  }
  return { messages: items, next_cursor: nextCursor };
}

/**
 * `list_messages` tool factory. Stamps `cursor` in the SQL helper so
 * cursor-based pagination reuses the same `MessageCursor` shape that
 * the existing REST list uses.
 */
export function listMessagesTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: LIST_MESSAGES_TOOL.name,
    description: LIST_MESSAGES_TOOL.description,
    inputSchema: LIST_MESSAGES_TOOL.inputSchema as ReadToolDef["inputSchema"],
    handler: async (args) => {
      const result = await runListMessages(ctx, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  };
}
