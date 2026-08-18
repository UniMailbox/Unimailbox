import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { redactText } from "../pii";
import type { ReadToolDef } from "./_shared";

/**
 * Input schema for `list_threads`. Threads are aggregated on the
 * `messages.thread_id` column and surfaced per mailbox. Each thread row
 * includes the message count, the last activity timestamp, and the
 * distinct sender/recipient set so the model can pick a thread to dig
 * into without first fetching every message.
 */
export const ListThreadsInputSchema = z.object({
  mailbox_id: z.string().min(1),
  since: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

export type ListThreadsInput = z.infer<typeof ListThreadsInputSchema>;

const LIST_THREADS_TOOL = {
  name: "list_threads",
  description:
    "List email threads in a mailbox with message counts and last activity timestamps.",
  inputSchema: {
    type: "object",
    properties: {
      mailbox_id: { type: "string", description: "Mailbox ULID." },
      since: { type: "string", description: "ISO datetime lower bound." },
      before: { type: "string", description: "ISO datetime upper bound." },
      limit: { type: "number", description: "1-100; defaults to 50." },
      cursor: { type: "string", description: "Opaque pagination cursor." },
    },
    additionalProperties: false,
  },
} as const;

interface ThreadRow {
  thread_id: string;
  subject: string;
  message_count: number;
  last_activity_at: string;
}

interface ThreadParticipantRow {
  thread_id: string;
  from_address: string;
  from_name: string;
}

/**
 * Decode the opaque cursor. We share the message cursor codec; the
 * payload shape is the canonical `{ createdAt, id }` and the SQL
 * `ORDER BY` / `WHERE` keys below must use those exact field names.
 */
async function decodeCursor(
  ctx: McpToolContext,
  cursor: string,
): Promise<{ createdAt: string; id: string }> {
  try {
    return await ctx.modules.cursors.decode(cursor);
  } catch {
    throw new McpToolError("invalid_args", "Cursor is malformed");
  }
}

async function runListThreads(
  ctx: McpToolContext,
  rawArgs: Record<string, unknown>,
): Promise<{
  threads: Array<{
    id: string;
    subject: string;
    message_count: number;
    last_activity_at: string;
    participants: Array<{ address: string; name: string }>;
  }>;
  next_cursor: string | null;
}> {
  const parsedInput = ListThreadsInputSchema.safeParse(rawArgs);
  if (!parsedInput.success) {
    throw new McpToolError(
      "invalid_args",
      undefined,
      parsedInput.error.flatten(),
    );
  }
  const input = parsedInput.data;

  const access = await ctx.modules.mailboxes.findAccess(
    ctx.principal.userId,
    input.mailbox_id,
  );
  if (!access) {
    throw new McpToolError("not_found", "Mailbox not found");
  }

  const lastActivityExpr = "COALESCE(m.received_at, m.sent_at, m.created_at)";
  const where: string[] = ["mm.mailbox_id = ?"];
  const params: unknown[] = [input.mailbox_id];
  if (input.since) {
    where.push(`${lastActivityExpr} >= ?`);
    params.push(input.since);
  }
  if (input.before) {
    where.push(`${lastActivityExpr} < ?`);
    params.push(input.before);
  }
  if (input.cursor) {
    const decoded = await decodeCursor(ctx, input.cursor);
    where.push(
      `(${lastActivityExpr} < ? ` +
        `OR (${lastActivityExpr} = ? ` +
        `AND m.thread_id < ?))`,
    );
    params.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }
  const sql = `SELECT m.thread_id,
                      MAX(${lastActivityExpr}) AS last_activity_at,
                      COALESCE(MAX(m.subject), '') AS subject,
                      COUNT(*) AS message_count
               FROM mailbox_messages mm
               JOIN messages m ON m.id = mm.message_id
               WHERE ${where.join(" AND ")}
               GROUP BY m.thread_id
               ORDER BY last_activity_at DESC, m.thread_id DESC
               LIMIT ?`;
  params.push(input.limit + 1);
  const result = await ctx.env.DB.prepare(sql)
    .bind(...params)
    .all<ThreadRow>();
  const hasNext = result.results.length > input.limit;
  const items = hasNext ? result.results.slice(0, input.limit) : result.results;
  const threadIds = items.map((row) => row.thread_id);
  const participantsByThread = new Map<
    string,
    Array<{ address: string; name: string }>
  >();
  if (threadIds.length > 0) {
    const placeholders = threadIds.map(() => "?").join(",");
    const participants = await ctx.env.DB.prepare(
      `SELECT m.thread_id, m.from_address, m.from_name
       FROM messages m
       JOIN mailbox_messages mm ON mm.message_id = m.id
       WHERE mm.mailbox_id = ? AND m.thread_id IN (${placeholders})
       ORDER BY m.created_at ASC`,
    )
      .bind(input.mailbox_id, ...threadIds)
      .all<ThreadParticipantRow>();
    for (const row of participants.results) {
      const bucket = participantsByThread.get(row.thread_id) ?? [];
      const key = row.from_address.toLowerCase();
      if (!bucket.some((entry) => entry.address.toLowerCase() === key)) {
        bucket.push({
          address: redactText(row.from_address),
          name: redactText(row.from_name),
        });
      }
      participantsByThread.set(row.thread_id, bucket);
    }
  }
  const threads = items.map((row) => ({
    id: row.thread_id,
    subject: redactText(row.subject),
    message_count: row.message_count,
    last_activity_at: row.last_activity_at,
    participants: participantsByThread.get(row.thread_id) ?? [],
  }));
  const last = items.at(-1);
  let nextCursor: string | null = null;
  if (hasNext && last) {
    nextCursor = await ctx.modules.cursors.encode({
      createdAt: last.last_activity_at,
      id: last.thread_id,
    });
  }
  return { threads, next_cursor: nextCursor };
}

export function listThreadsTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: LIST_THREADS_TOOL.name,
    description: LIST_THREADS_TOOL.description,
    inputSchema: LIST_THREADS_TOOL.inputSchema as ReadToolDef["inputSchema"],
    handler: async (args) => {
      const result = await runListThreads(ctx, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  };
}
