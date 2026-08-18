import { z } from "zod";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { classifyMessage } from "../../agent/classify";
import { extractActionItems } from "../../agent/extract-actions";
import { summarizeThread } from "../../agent/summarize";
import type { ReadToolDef } from "./_shared";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});
async function readable(
  ctx: McpToolContext,
  messageId: string,
): Promise<{ text_body: string; subject: string }> {
  const message = (await ctx.modules.messages.get(
    ctx.principal,
    messageId,
  )) as { text_body?: unknown; subject?: unknown } | null;
  if (!message || typeof message.text_body !== "string")
    throw new McpToolError("not_found", "Message not found");
  return {
    text_body: message.text_body,
    subject: typeof message.subject === "string" ? message.subject : "",
  };
}
export function summarizeThreadTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: "summarize_thread",
    description: "Summarize an email thread with Workers AI.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        model: { type: "string", enum: ["8b", "70b"] },
      },
      required: ["thread_id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = z
        .object({
          thread_id: z.string().min(1),
          model: z.enum(["8b", "70b"]).default("8b"),
        })
        .safeParse(args);
      if (!parsed.success)
        throw new McpToolError(
          "invalid_args",
          undefined,
          parsed.error.flatten(),
        );
      const rows = await ctx.env.DB.prepare(
        "SELECT subject, text_body FROM messages m JOIN mailbox_messages mm ON mm.message_id = m.id WHERE m.thread_id = ? ORDER BY m.created_at ASC LIMIT 100",
      )
        .bind(parsed.data.thread_id)
        .all<{ subject: string; text_body: string }>();
      if (rows.results.length === 0)
        throw new McpToolError("not_found", "Thread not found");
      const model =
        parsed.data.model === "70b"
          ? "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
          : "@cf/meta/llama-3.1-8b-instruct";
      const summary = await summarizeThread(
        ctx.env,
        rows.results.map((row) => `${row.subject}\n${row.text_body}`),
      );
      return text({ summary, model: parsed.data.model });
    },
  };
}
export function classifyMessageTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: "classify_message",
    description: "Classify a message with Workers AI.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = z
        .object({ message_id: z.string().min(1) })
        .safeParse(args);
      if (!parsed.success)
        throw new McpToolError(
          "invalid_args",
          undefined,
          parsed.error.flatten(),
        );
      const message = await readable(ctx, parsed.data.message_id);
      return text(
        await classifyMessage(
          ctx.env,
          `${message.subject}\n${message.text_body}`,
        ),
      );
    },
  };
}
export function extractActionItemsTool(ctx: McpToolContext): ReadToolDef {
  return {
    name: "extract_action_items",
    description: "Extract action items from a message with Workers AI.",
    inputSchema: {
      type: "object",
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const parsed = z
        .object({ message_id: z.string().min(1) })
        .safeParse(args);
      if (!parsed.success)
        throw new McpToolError(
          "invalid_args",
          undefined,
          parsed.error.flatten(),
        );
      const message = await readable(ctx, parsed.data.message_id);
      return text({
        items: await extractActionItems(
          ctx.env,
          `${message.subject}\n${message.text_body}`,
        ),
      });
    },
  };
}
export { readable };
