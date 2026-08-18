import { z } from "zod";
import type { SendMessageInput } from "@unimailbox/contracts";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { wrapWithConfirmation } from "../confirmation-flow";
import { idempotencyForMcp } from "../idempotency";
import type { WriteToolDef } from "./write-common";

const AddressListSchema = z.array(z.string().email()).max(100).default([]);
const IdempotencyKeySchema = z.string().min(1).max(255);

export const ReplyMessageInputSchema = z.object({
  message_id: z.string().min(1),
  text_body: z.string().max(2_000_000),
  html_body: z.string().max(2_000_000).optional(),
  cc: AddressListSchema,
  bcc: AddressListSchema,
  all: z.boolean().default(false),
  confirmation_token: z.string().min(1).optional(),
  idempotency_key: IdempotencyKeySchema,
});

export const ForwardMessageInputSchema = z.object({
  message_id: z.string().min(1),
  to: z.array(z.string().email()).min(1).max(100),
  cc: AddressListSchema,
  bcc: AddressListSchema,
  body_prefix: z.string().max(2_000_000).default(""),
  confirmation_token: z.string().min(1).optional(),
  idempotency_key: IdempotencyKeySchema,
});

export const MessageStateInputSchema = z.object({
  message_id: z.string().min(1),
  value: z.boolean().default(true),
});

export const MoveMessageInputSchema = z.object({
  message_id: z.string().min(1),
  mailbox_id: z.string().min(1),
  target_folder: z.enum(["inbox", "sent", "drafts", "archive", "trash"]),
  idempotency_key: IdempotencyKeySchema,
});

export const MoveShortcutInputSchema = z.object({
  message_id: z.string().min(1),
  mailbox_id: z.string().min(1),
  idempotency_key: IdempotencyKeySchema,
});

type ReplyMessageInput = z.infer<typeof ReplyMessageInputSchema>;
type ForwardMessageInput = z.infer<typeof ForwardMessageInputSchema>;
type MoveMessageInput = z.infer<typeof MoveMessageInputSchema>;
type MovableFolder = "inbox" | "archive" | "trash";

const SourceMessageSchema = z.object({
  mailboxId: z.string().min(1),
  from_address: z.string().email(),
  subject: z.string(),
  text_body: z.string(),
  html_body: z.string(),
  recipients: z
    .array(
      z.object({
        type: z.enum(["to", "cc", "bcc"]),
        address: z.string().email(),
      }),
    )
    .default([]),
});

type SourceMessage = z.infer<typeof SourceMessageSchema>;

const replyJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    text_body: { type: "string", maxLength: 2_000_000 },
    html_body: { type: "string", maxLength: 2_000_000 },
    cc: { type: "array", items: { type: "string", format: "email" } },
    bcc: { type: "array", items: { type: "string", format: "email" } },
    all: { type: "boolean", default: false },
    confirmation_token: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["message_id", "text_body", "idempotency_key"],
  additionalProperties: false,
};

const forwardJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    to: { type: "array", items: { type: "string", format: "email" } },
    cc: { type: "array", items: { type: "string", format: "email" } },
    bcc: { type: "array", items: { type: "string", format: "email" } },
    body_prefix: { type: "string", maxLength: 2_000_000 },
    confirmation_token: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["message_id", "to", "idempotency_key"],
  additionalProperties: false,
};

const stateJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    value: { type: "boolean", default: true },
  },
  required: ["message_id"],
  additionalProperties: false,
};

const moveJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    mailbox_id: { type: "string" },
    target_folder: {
      type: "string",
      enum: ["inbox", "sent", "drafts", "archive", "trash"],
    },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["message_id", "mailbox_id", "target_folder", "idempotency_key"],
  additionalProperties: false,
};

const shortcutJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    message_id: { type: "string" },
    mailbox_id: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["message_id", "mailbox_id", "idempotency_key"],
  additionalProperties: false,
};

function invalidArgs(error: z.ZodError): McpToolError {
  return new McpToolError("invalid_args", undefined, error.flatten());
}

function parseSource(value: unknown): SourceMessage {
  const parsed = SourceMessageSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpToolError("not_found", "Source message is unavailable");
  }
  return parsed.data;
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    const normalized = address.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(address);
    }
  }
  return result;
}

function replyRecipients(
  principalEmail: string,
  input: ReplyMessageInput,
  source: SourceMessage,
): { to: string[]; cc: string[]; bcc: string[] } {
  const to = [source.from_address];
  const replyAllCc = input.all
    ? source.recipients
        .filter((recipient) => recipient.type !== "bcc")
        .map((recipient) => recipient.address)
        .filter(
          (address) =>
            address.toLowerCase() !== principalEmail.toLowerCase() &&
            address.toLowerCase() !== source.from_address.toLowerCase(),
        )
    : [];
  return {
    to,
    cc: uniqueAddresses([...replyAllCc, ...input.cc]),
    bcc: uniqueAddresses(input.bcc),
  };
}

function replySubject(subject: string): string {
  return /^re:/iu.test(subject) ? subject : `Re: ${subject}`;
}

function forwardSubject(subject: string): string {
  return /^fwd:/iu.test(subject) ? subject : `Fwd: ${subject}`;
}

function forwardedText(prefix: string, source: SourceMessage): string {
  const separator = prefix.length > 0 ? `${prefix}\n\n` : "";
  return `${separator}---------- Forwarded message ----------\n${source.text_body}`;
}

function forwardedHtml(prefix: string, source: SourceMessage): string {
  const prefixHtml = prefix.length > 0 ? `<p>${prefix}</p>` : "";
  return `${prefixHtml}<hr><p>Forwarded message</p>${source.html_body}`;
}

export function replyMessageTool(ctx: McpToolContext): WriteToolDef {
  return {
    name: "reply_message",
    description:
      "Reply to a message in two stages. The service automatically sets In-Reply-To and References from message_id.",
    inputSchema: replyJsonSchema,
    handler: async (rawArgs) => {
      const parsed = ReplyMessageInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const source = parseSource(
        await ctx.modules.messages.get(ctx.principal, input.message_id),
      );
      const recipients = replyRecipients(ctx.principal.email, input, source);
      const payload: SendMessageInput = {
        mailboxId: source.mailboxId,
        ...recipients,
        subject: replySubject(source.subject),
        text: input.text_body,
        html: input.html_body ?? "",
        parentMessageId: input.message_id,
        includeSignature: true,
        attachmentIds: [],
      };
      const flow = await wrapWithConfirmation(
        ctx.modules,
        ctx.principal,
        input,
        () => ({
          message_id: input.message_id,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject: payload.subject,
          text_body: input.text_body,
          html_body: input.html_body ?? "",
          reply_chain: true,
        }),
        () =>
          idempotencyForMcp(
            ctx.modules,
            ctx.principal,
            input.idempotency_key,
            payload,
            () =>
              ctx.modules.messages.send(
                ctx.principal,
                payload,
                input.idempotency_key,
              ),
          ),
      );
      const structuredContent: Record<string, unknown> = { ...flow };
      return {
        content: [{ type: "text", text: JSON.stringify(flow) }],
        structuredContent,
      };
    },
  };
}

export function forwardMessageTool(ctx: McpToolContext): WriteToolDef {
  return {
    name: "forward_message",
    description:
      "Forward an existing message in two stages, optionally prepending a body prefix.",
    inputSchema: forwardJsonSchema,
    handler: async (rawArgs) => {
      const parsed = ForwardMessageInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const source = parseSource(
        await ctx.modules.messages.get(ctx.principal, input.message_id),
      );
      const payload: SendMessageInput = {
        mailboxId: source.mailboxId,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: forwardSubject(source.subject),
        text: forwardedText(input.body_prefix, source),
        html: forwardedHtml(input.body_prefix, source),
        includeSignature: true,
        attachmentIds: [],
      };
      const flow = await wrapWithConfirmation(
        ctx.modules,
        ctx.principal,
        input,
        () => ({
          message_id: input.message_id,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: payload.subject,
          body_prefix: input.body_prefix,
        }),
        () =>
          idempotencyForMcp(
            ctx.modules,
            ctx.principal,
            input.idempotency_key,
            payload,
            () =>
              ctx.modules.messages.send(
                ctx.principal,
                payload,
                input.idempotency_key,
              ),
          ),
      );
      const structuredContent: Record<string, unknown> = { ...flow };
      return {
        content: [{ type: "text", text: JSON.stringify(flow) }],
        structuredContent,
      };
    },
  };
}

function stateTool(
  ctx: McpToolContext,
  name: "mark_as_read" | "mark_as_starred",
): WriteToolDef {
  const isRead = name === "mark_as_read";
  return {
    name,
    description: `Set a message's ${isRead ? "read" : "starred"} state. Repeating the same value is safe.`,
    inputSchema: stateJsonSchema,
    handler: async (rawArgs) => {
      const parsed = MessageStateInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      if (isRead) {
        await ctx.modules.messages.setRead(
          ctx.principal,
          input.message_id,
          input.value,
        );
      } else {
        await ctx.modules.messages.setStarred(
          ctx.principal,
          input.message_id,
          input.value,
        );
      }
      const result = { message_id: input.message_id, value: input.value };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}

export function markAsReadTool(ctx: McpToolContext): WriteToolDef {
  return stateTool(ctx, "mark_as_read");
}

export function markAsStarredTool(ctx: McpToolContext): WriteToolDef {
  return stateTool(ctx, "mark_as_starred");
}

function movableFolder(
  folder: MoveMessageInput["target_folder"],
): MovableFolder {
  if (folder === "sent" || folder === "drafts") {
    throw new McpToolError(
      "invalid_args",
      `Moving an existing message to ${folder} is not supported`,
    );
  }
  return folder;
}

async function moveWithIdempotency(
  ctx: McpToolContext,
  input: {
    message_id: string;
    mailbox_id: string;
    idempotency_key: string;
  },
  folder: MovableFolder,
) {
  return idempotencyForMcp(
    ctx.modules,
    ctx.principal,
    input.idempotency_key,
    { message_id: input.message_id, mailbox_id: input.mailbox_id, folder },
    async () => {
      await ctx.modules.messages.move(
        ctx.principal,
        input.message_id,
        input.mailbox_id,
        folder,
      );
      return { message_id: input.message_id, target_folder: folder };
    },
  );
}

export function moveMessageTool(ctx: McpToolContext): WriteToolDef {
  return {
    name: "move_message",
    description:
      "Move a message within a mailbox. Inbox, archive, and trash are supported destinations.",
    inputSchema: moveJsonSchema,
    handler: async (rawArgs) => {
      const parsed = MoveMessageInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const result = await moveWithIdempotency(
        ctx,
        input,
        movableFolder(input.target_folder),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}

function moveShortcutTool(
  ctx: McpToolContext,
  name: "archive_message" | "trash_message",
  folder: "archive" | "trash",
): WriteToolDef {
  return {
    name,
    description: `Move a message to ${folder}. This is a soft, reversible folder move.`,
    inputSchema: shortcutJsonSchema,
    handler: async (rawArgs) => {
      const parsed = MoveShortcutInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const result = await moveWithIdempotency(ctx, parsed.data, folder);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}

export function archiveMessageTool(ctx: McpToolContext): WriteToolDef {
  return moveShortcutTool(ctx, "archive_message", "archive");
}

export function trashMessageTool(ctx: McpToolContext): WriteToolDef {
  return moveShortcutTool(ctx, "trash_message", "trash");
}
