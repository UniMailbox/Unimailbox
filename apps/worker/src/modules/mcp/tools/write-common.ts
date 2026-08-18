import { z } from "zod";
import type { SendMessageInput } from "@unimailbox/contracts";
import type { McpToolContext } from "../context";
import { McpToolError } from "../errors";
import { wrapWithConfirmation } from "../confirmation-flow";
import { idempotencyForMcp } from "../idempotency";
import type { ReadToolDef } from "./_shared";

const RecipientListSchema = z.array(z.string().email()).max(100).default([]);

export const SendInputSchema = z.object({
  mailbox_id: z.string().min(1),
  to: z.array(z.string().email()).min(1).max(100),
  cc: RecipientListSchema,
  bcc: RecipientListSchema,
  subject: z.string().max(998).default(""),
  text_body: z.string().max(2_000_000).default(""),
  html_body: z.string().max(2_000_000).optional(),
  attachments: z.array(z.string().min(1)).max(25).default([]),
  confirmation_token: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).max(255),
});

export const DraftInputSchema = SendInputSchema.omit({
  confirmation_token: true,
});

export type SendInput = z.infer<typeof SendInputSchema>;
export type DraftInput = z.infer<typeof DraftInputSchema>;
export type WriteToolDef = ReadToolDef;

const sendInputJsonSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    mailbox_id: { type: "string", description: "Sender mailbox id." },
    to: { type: "array", items: { type: "string", format: "email" } },
    cc: { type: "array", items: { type: "string", format: "email" } },
    bcc: { type: "array", items: { type: "string", format: "email" } },
    subject: { type: "string", maxLength: 998 },
    text_body: { type: "string", maxLength: 2_000_000 },
    html_body: { type: "string", maxLength: 2_000_000 },
    attachments: { type: "array", items: { type: "string" }, maxItems: 25 },
    confirmation_token: { type: "string" },
    idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
  },
  required: ["mailbox_id", "to", "idempotency_key"],
  additionalProperties: false,
};

const draftInputJsonSchema: Record<string, unknown> = {
  ...sendInputJsonSchema,
  properties: {
    ...(sendInputJsonSchema.properties as Record<string, unknown>),
    confirmation_token: undefined,
  },
};
delete (draftInputJsonSchema.properties as Record<string, unknown>)
  .confirmation_token;

export interface WriteAuditShape {
  keys: string[];
  counts: {
    to: number;
    cc: number;
    bcc: number;
    attachments: number;
  };
  lengths: {
    subject: number;
    text_body: number;
    html_body: number;
  };
}

/** Shape-only projection for write-tool audit records. */
export function shapeArgsForAudit(
  args: Record<string, unknown>,
): WriteAuditShape {
  const count = (key: string): number =>
    Array.isArray(args[key]) ? args[key].length : 0;
  const length = (key: string): number =>
    typeof args[key] === "string" ? args[key].length : 0;
  return {
    keys: Object.keys(args).sort(),
    counts: {
      to: count("to"),
      cc: count("cc"),
      bcc: count("bcc"),
      attachments: count("attachments"),
    },
    lengths: {
      subject: length("subject"),
      text_body: length("text_body"),
      html_body: length("html_body"),
    },
  };
}

function toSendPayload(input: SendInput | DraftInput): SendMessageInput {
  return {
    mailboxId: input.mailbox_id,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text_body,
    html: input.html_body ?? "",
    attachmentIds: input.attachments,
    includeSignature: true,
  };
}

function invalidArgs(error: z.ZodError): McpToolError {
  return new McpToolError("invalid_args", undefined, error.flatten());
}

export function sendMessageTool(ctx: McpToolContext): WriteToolDef {
  return {
    name: "send_message",
    description:
      "Send an email in two stages. Omit confirmation_token for a preview, then repeat the exact arguments with the returned token to deliver.",
    inputSchema: sendInputJsonSchema,
    handler: async (rawArgs) => {
      const parsed = SendInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const payload = toSendPayload(input);
      const flow = await wrapWithConfirmation(
        ctx.modules,
        ctx.principal,
        input,
        () => ({
          mailbox_id: input.mailbox_id,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          text_body: input.text_body,
          html_body: input.html_body ?? "",
          attachments: input.attachments.map((id) => ({ id })),
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

export function draftMessageTool(ctx: McpToolContext): WriteToolDef {
  return {
    name: "draft_message",
    description: "Create an email draft without sending it.",
    inputSchema: draftInputJsonSchema,
    handler: async (rawArgs) => {
      const parsed = DraftInputSchema.safeParse(rawArgs);
      if (!parsed.success) throw invalidArgs(parsed.error);
      const input = parsed.data;
      const payload = toSendPayload(input);
      const draft = await idempotencyForMcp(
        ctx.modules,
        ctx.principal,
        input.idempotency_key,
        payload,
        () => ctx.modules.drafts.create(ctx.principal, payload),
      );
      const result = { draft_id: draft.id, replayed: draft.replayed };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}
