import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { redactText } from "../pii";
import { embedMessage } from "../../agent/embed";
import type { ReadToolDef } from "./_shared";

/**
 * Input schema for `search_messages`. The `query` field accepts a small
 * subset of the language documented in impl doc §4.2:
 *
 *   from:alice          substring match on the sender
 *   subject:invoice     substring match on the subject
 *   newer_than:7d       restricts to messages newer than 7 days
 *   newer_than:2h       hours unit also supported
 *   <plain text>        matched against subject + body via LIKE
 *
 * Anything else is treated as a free-text fragment and combined with
 * AND semantics. The parser is intentionally narrow — semantic search
 * (Vectorize) lands in PR #6.
 */
export const SearchMessagesInputSchema = z.object({
  mailbox_id: z.string().min(1),
  query: z.string().min(1).max(512),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

export type SearchMessagesInput = z.infer<typeof SearchMessagesInputSchema>;

interface ParsedQuery {
  from?: string;
  subject?: string;
  sinceIso?: string;
  freeText: string[];
}

/**
 * Parse the `query` blob into structured fragments. Exported for tests so
 * the parser surface can be asserted in isolation.
 *
 * The grammar recognises `from:<value>`, `subject:<value>`, and
 * `newer_than:<n><h|d|w|m>`, where each value is either a bare
 * whitespace-delimited token or a quoted string (`"…"`). Quoted values
 * preserve internal whitespace so `subject:"invoice Q4"` works.
 */
export function parseSearchQuery(
  query: string,
  now: number = Date.now(),
): ParsedQuery {
  const result: ParsedQuery = { freeText: [] };
  let remaining = query;
  for (const match of remaining.matchAll(
    /\b(from|subject|newer_than):(?:"([^"]*)"|(\S+))/giu,
  )) {
    const index = match.index ?? 0;
    const length = match[0].length;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    // Splice the matched fragment out of the string so leftover text only
    // contains free-text tokens.
    remaining =
      remaining.slice(0, index) + " " + remaining.slice(index + length);
    if (!value) continue;
    if (key === "from") {
      result.from = value;
    } else if (key === "subject") {
      result.subject = value;
    } else if (key === "newer_than") {
      const unitMatch = value.match(/^(\d+)\s*([hdwm])$/u);
      if (unitMatch) {
        const amount = Number.parseInt(unitMatch[1] ?? "0", 10);
        const unit = unitMatch[2] ?? "d";
        const since = new Date(now - amount * unitToMs(unit));
        result.sinceIso = since.toISOString();
      }
    }
  }
  for (const raw of remaining.match(/"[^"]+"|\S+/g) ?? []) {
    const token = raw.replace(/^"+|"+$/g, "");
    if (token.length > 0) result.freeText.push(token);
  }
  return result;
}

function unitToMs(unit: string): number {
  switch (unit) {
    case "h":
      return 60 * 60 * 1000;
    case "d":
      return 24 * 60 * 60 * 1000;
    case "w":
      return 7 * 24 * 60 * 60 * 1000;
    case "m":
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

const PREVIEW_BYTES = 2 * 1024;

const SEARCH_MESSAGES_TOOL = {
  name: "search_messages",
  description:
    "Search messages in a mailbox using a tiny query DSL: " +
    "from:<addr>, subject:<text>, newer_than:<n><h|d|w|m>, plus free text matched against subject + body.",
  inputSchema: {
    type: "object",
    properties: {
      mailbox_id: {
        type: "string",
        description: "Mailbox ULID the principal has read access to.",
      },
      query: {
        type: "string",
        description: "Search expression (see tool description).",
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

interface SearchRow {
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
 * Build the SQL for a parsed search query. Pulled out for unit testing
 * so the structure can be asserted without touching D1.
 */
export async function buildSearchMessagesQuery(
  ctx: McpToolContext,
  input: SearchMessagesInput,
  parsed: ParsedQuery,
): Promise<{ sql: string; params: unknown[] }> {
  const where: string[] = ["mm.mailbox_id = ?"];
  const params: unknown[] = [input.mailbox_id];
  if (parsed.from) {
    where.push("m.from_address LIKE ? COLLATE NOCASE");
    params.push(`%${parsed.from}%`);
  }
  if (parsed.subject) {
    where.push("m.subject LIKE ? COLLATE NOCASE");
    params.push(`%${parsed.subject}%`);
  }
  if (parsed.sinceIso) {
    where.push("COALESCE(m.received_at, m.sent_at, m.created_at) >= ?");
    params.push(parsed.sinceIso);
  }
  for (const text of parsed.freeText) {
    where.push(
      "(m.subject LIKE ? COLLATE NOCASE OR m.text_body LIKE ? COLLATE NOCASE)",
    );
    params.push(`%${text}%`, `%${text}%`);
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
  params.push(input.limit + 1);
  return { sql, params };
}

function clip(text: string): string {
  return text.length <= PREVIEW_BYTES ? text : text.slice(0, PREVIEW_BYTES);
}

async function runSearchMessages(
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
  semantic?: Array<{ id: string; score: number; snippet: string }>;
}> {
  const parsedInput = SearchMessagesInputSchema.safeParse(rawArgs);
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
  const parsed = parseSearchQuery(input.query);
  const { sql, params } = await buildSearchMessagesQuery(ctx, input, parsed);
  const result = await ctx.env.DB.prepare(sql)
    .bind(...params)
    .all<SearchRow>();
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
  let semantic:
    | Array<{ id: string; score: number; snippet: string }>
    | undefined;
  if (items.length === 0 && ctx.env.VECTORIZE && parsed.freeText.length > 0) {
    try {
      const vector = await embedMessage(ctx.env, parsed.freeText.join(" "));
      const result = await ctx.env.VECTORIZE.query(vector, {
        namespace: input.mailbox_id,
        topK: 20,
        returnMetadata: "indexed",
      });
      semantic = result.matches
        .filter(
          (match): boolean =>
            typeof match.id === "string" && typeof match.score === "number",
        )
        .map((match) => ({
          id: String(match.id),
          score: Number(match.score),
          snippet:
            typeof (match.metadata as { snippet?: unknown } | undefined)
              ?.snippet === "string"
              ? redactText(
                  (match.metadata as { snippet: string }).snippet,
                ).slice(0, 256)
              : "",
        }));
    } catch {
      /* best effort */
    }
  }
  return {
    messages: items,
    next_cursor: nextCursor,
    ...(semantic ? { semantic } : {}),
  };
}

export function searchMessagesTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: SEARCH_MESSAGES_TOOL.name,
    description: SEARCH_MESSAGES_TOOL.description,
    inputSchema: SEARCH_MESSAGES_TOOL.inputSchema as ReadToolDef["inputSchema"],
    handler: async (args) => {
      const result = await runSearchMessages(ctx, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  };
}
