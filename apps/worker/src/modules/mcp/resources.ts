import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";
import { McpToolError } from "./errors";
import { redactText, wrapUntrustedEmail } from "./pii";

/**
 * MCP resource descriptors exposed by the first-party server.
 *
 * Each entry is a `(ctx, principal, uriParams) => contents` factory. PR #3
 * covers read-only passive resources; PR #4+ will layer write semantics on
 * top of the same template surface (e.g. `unimailbox://drafts/{id}`).
 *
 * String payloads go through `redactText` first per impl doc §5.2, and any
 * field carrying an email body is wrapped with `wrapUntrustedEmail` so the
 * downstream model can mark the content as untrusted.
 */
const MAX_PREVIEW_BYTES = 2 * 1024; // 2 KiB per impl doc §2.9

interface MailboxRow {
  id: string;
  address: string;
  role: string;
}

interface MessagePreviewRow {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  text_body: string;
  received_at: string | null;
  sent_at: string | null;
  created_at: string;
}

interface MessagePreview {
  id: string;
  from: string;
  subject: string;
  preview: string;
  received_at: string | null;
}

interface ThreadMessageRow {
  id: string;
  from_address: string;
  from_name: string;
  subject: string;
  text_body: string;
  received_at: string | null;
  sent_at: string | null;
  created_at: string;
}

function clipPreview(
  text: string,
  byteCap: number = MAX_PREVIEW_BYTES,
): string {
  if (text.length <= byteCap) return text;
  return text.slice(0, byteCap);
}

function toMessagePreview(row: MessagePreviewRow): MessagePreview {
  return {
    id: row.id,
    from: redactText(row.from_address),
    subject: redactText(row.subject),
    preview: redactText(clipPreview(row.text_body)),
    received_at: row.received_at ?? row.sent_at ?? row.created_at,
  };
}

export interface ResourceHandler {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  read(
    principal: Principal,
    params: Record<string, string>,
  ): Promise<{ contents: ResourceContent[] }>;
}

interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
}

/**
 * `unimailbox://mailboxes` — list principal's accessible mailboxes. The
 * resource is intentionally narrow: it returns only `id`, `address`, and
 * `role`. Other mailbox metadata (display name, status, domain) is
 * available through the existing REST API.
 */
export function listMailboxesResource(_ctx: AppContext): ResourceHandler {
  return {
    uri: "unimailbox://mailboxes",
    name: "mailboxes",
    description: "List mailboxes accessible by the principal.",
    mimeType: "application/json",
    async read(principal) {
      const result = await _ctx.env.DB.prepare(
        `SELECT m.id, m.address,
                CASE WHEN m.owner_user_id = ? THEN 'owner' ELSE mm.role END AS role
         FROM mailboxes m
         LEFT JOIN mailbox_members mm
           ON mm.mailbox_id = m.id AND mm.user_id = ?
         WHERE m.owner_user_id = ? OR mm.user_id = ?
         ORDER BY m.address`,
      )
        .bind(
          principal.userId,
          principal.userId,
          principal.userId,
          principal.userId,
        )
        .all<MailboxRow>();
      const items = result.results.map((row) => ({
        id: row.id,
        address: row.address,
        role: row.role,
      }));
      return {
        contents: [
          {
            uri: "unimailbox://mailboxes",
            mimeType: "application/json",
            text: JSON.stringify(items),
          },
        ],
      };
    },
  };
}

/**
 * `unimailbox://mailboxes/{mailbox_id}/messages` — preview-only message
 * listing. Each item is capped at ~2 KiB before redaction. Returns the
 * inbox folder by default; per-folder filtering is the responsibility
 * of the caller (`list_messages` tool covers that case).
 */
export function listMailboxMessagesResource(ctx: AppContext): ResourceHandler {
  return {
    uri: "unimailbox://mailboxes/{mailbox_id}/messages",
    name: "mailbox_messages",
    description:
      "Preview-only list of messages in a mailbox (2 KiB cap per item).",
    mimeType: "application/json",
    async read(principal, params) {
      const mailboxId = params.mailbox_id;
      if (!mailboxId) {
        throw new McpToolError("invalid_args", "mailbox_id is required");
      }
      // Assert the principal can read this mailbox.
      const access = await ctx.mailboxes.findAccess(
        principal.userId,
        mailboxId,
      );
      if (!access) {
        throw new McpToolError("not_found", "Mailbox not found");
      }
      const result = await ctx.env.DB.prepare(
        `SELECT m.id, m.from_address, m.from_name, m.subject, m.text_body,
                m.received_at, m.sent_at, m.created_at
         FROM mailbox_messages mm
         JOIN messages m ON m.id = mm.message_id
         WHERE mm.mailbox_id = ? AND mm.folder = 'inbox'
           AND NOT EXISTS (
             SELECT 1 FROM message_user_state mus
             WHERE mus.mailbox_message_id = mm.id
               AND mus.user_id = ?
               AND mus.deleted_at IS NOT NULL
           )
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT 50`,
      )
        .bind(mailboxId, principal.userId)
        .all<MessagePreviewRow>();
      const items = result.results.map(toMessagePreview);
      return {
        contents: [
          {
            uri: `unimailbox://mailboxes/${mailboxId}/messages`,
            mimeType: "application/json",
            text: JSON.stringify(items),
          },
        ],
      };
    },
  };
}

/**
 * `unimailbox://messages/{message_id}` — single message preview with
 * PII redaction applied. Body content is wrapped in the untrusted-email
 * sentinel pair per impl doc §5.2.
 */
export function getMessageResource(ctx: AppContext): ResourceHandler {
  return {
    uri: "unimailbox://messages/{message_id}",
    name: "message",
    description:
      "Preview of a single message (PII-redacted, body wrapped in untrusted-email sentinels).",
    mimeType: "application/json",
    async read(principal, params) {
      const messageId = params.message_id;
      if (!messageId) {
        throw new McpToolError("invalid_args", "message_id is required");
      }
      const link = await ctx.env.DB.prepare(
        `SELECT mm.id AS mailbox_message_id, mm.mailbox_id
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
        .first<{ mailbox_message_id: string; mailbox_id: string }>();
      if (!link) {
        throw new McpToolError("not_found", "Message not found");
      }
      const message = await ctx.env.DB.prepare(
        `SELECT id, from_address, from_name, subject, text_body,
                received_at, sent_at, created_at
         FROM messages WHERE id = ?`,
      )
        .bind(messageId)
        .first<MessagePreviewRow>();
      if (!message) {
        throw new McpToolError("not_found", "Message not found");
      }
      const redactedBody = redactText(clipPreview(message.text_body));
      const wrappedBody = wrapUntrustedEmail(redactedBody);
      const payload = {
        id: message.id,
        from: redactText(message.from_address),
        from_name: redactText(message.from_name),
        subject: redactText(message.subject),
        preview: redactedBody,
        body: wrappedBody,
        received_at:
          message.received_at ?? message.sent_at ?? message.created_at,
      };
      return {
        contents: [
          {
            uri: `unimailbox://messages/${messageId}`,
            mimeType: "application/json",
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  };
}

/**
 * `unimailbox://threads/{thread_id}` — aggregate of all messages on a
 * thread (preview-only). The principal MUST be able to read at least one
 * of the thread's mailbox links, otherwise the resource returns
 * `not_found` (matches `messages.get` semantics).
 */
export function getThreadResource(ctx: AppContext): ResourceHandler {
  return {
    uri: "unimailbox://threads/{thread_id}",
    name: "thread",
    description:
      "Aggregate of messages in a thread (preview-only, PII-redacted).",
    mimeType: "application/json",
    async read(principal, params) {
      const threadId = params.thread_id;
      if (!threadId) {
        throw new McpToolError("invalid_args", "thread_id is required");
      }
      // Confirm at least one message on this thread is in a mailbox the
      // principal can read.
      const accessibility = await ctx.env.DB.prepare(
        `SELECT 1
         FROM messages m
         JOIN mailbox_messages mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
         LEFT JOIN mailbox_members member
           ON member.mailbox_id = mb.id AND member.user_id = ?
         WHERE m.thread_id = ?
           AND (mb.owner_user_id = ? OR member.user_id = ?)
         LIMIT 1`,
      )
        .bind(principal.userId, threadId, principal.userId, principal.userId)
        .first<{ 1: number }>();
      if (!accessibility) {
        throw new McpToolError("not_found", "Thread not found");
      }
      const result = await ctx.env.DB.prepare(
        `SELECT m.id, m.from_address, m.from_name, m.subject, m.text_body,
                m.received_at, m.sent_at, m.created_at
         FROM messages m
         JOIN mailbox_messages mm ON mm.message_id = m.id
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
         LEFT JOIN mailbox_members member
           ON member.mailbox_id = mb.id AND member.user_id = ?
         WHERE m.thread_id = ?
           AND (mb.owner_user_id = ? OR member.user_id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM message_user_state mus
             WHERE mus.mailbox_message_id = mm.id
               AND mus.user_id = ?
               AND mus.deleted_at IS NOT NULL
           )
         ORDER BY m.created_at ASC, m.id ASC`,
      )
        .bind(
          principal.userId,
          threadId,
          principal.userId,
          principal.userId,
          principal.userId,
        )
        .all<ThreadMessageRow>();
      const messages = result.results.map(toMessagePreview);
      const participants = new Map<string, { address: string; name: string }>();
      for (const message of result.results) {
        const key = message.from_address.toLowerCase();
        if (!participants.has(key)) {
          participants.set(key, {
            address: redactText(message.from_address),
            name: redactText(message.from_name),
          });
        }
      }
      const payload = {
        id: threadId,
        message_count: messages.length,
        last_activity_at:
          messages.at(-1)?.received_at ?? messages.at(-1)?.id ?? null,
        participants: Array.from(participants.values()),
        messages,
      };
      return {
        contents: [
          {
            uri: `unimailbox://threads/${threadId}`,
            mimeType: "application/json",
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  };
}

/**
 * `unimailbox://labels` — list of system + user labels.
 *
 * The MVP has no `message_labels` table yet, so we synthesise the system
 * labels from `MailboxFolder` (inbox, sent, drafts, archive, trash) and
 * return an empty `user_labels` list. When the labels table lands (a
 * later PR), only the `user_labels` query needs to change.
 */
export function listLabelsResource(_ctx: AppContext): ResourceHandler {
  return {
    uri: "unimailbox://labels",
    name: "labels",
    description:
      "List of system labels (derived from mailbox folders) and user labels.",
    mimeType: "application/json",
    async read() {
      const system = [
        { id: "inbox", name: "Inbox", kind: "system" as const },
        { id: "sent", name: "Sent", kind: "system" as const },
        { id: "drafts", name: "Drafts", kind: "system" as const },
        { id: "archive", name: "Archive", kind: "system" as const },
        { id: "trash", name: "Trash", kind: "system" as const },
      ];
      const userLabels: Array<{ id: string; name: string; kind: "user" }> = [];
      const payload = { system, user_labels: userLabels };
      return {
        contents: [
          {
            uri: "unimailbox://labels",
            mimeType: "application/json",
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  };
}

/**
 * Static template catalogue. The dispatcher uses the templates to look up
 * the handler for `resources/read` (parameter names are extracted from the
 * `{name}` segments of the template).
 */
export const RESOURCE_TEMPLATES: ReadonlyArray<{
  uriTemplate: string;
  handler: (ctx: AppContext) => ResourceHandler;
}> = [
  {
    uriTemplate: "unimailbox://mailboxes",
    handler: listMailboxesResource,
  },
  {
    uriTemplate: "unimailbox://mailboxes/{mailbox_id}/messages",
    handler: listMailboxMessagesResource,
  },
  {
    uriTemplate: "unimailbox://messages/{message_id}",
    handler: getMessageResource,
  },
  {
    uriTemplate: "unimailbox://threads/{thread_id}",
    handler: getThreadResource,
  },
  {
    uriTemplate: "unimailbox://labels",
    handler: listLabelsResource,
  },
];

/**
 * Resolve a `resources/read` URI to its handler + extracted params.
 * Returns `null` when the URI does not match any registered template.
 */
export function matchResourceTemplate(
  ctx: AppContext,
  uri: string,
): { handler: ResourceHandler; params: Record<string, string> } | null {
  for (const entry of RESOURCE_TEMPLATES) {
    const params = matchTemplate(entry.uriTemplate, uri);
    if (params) {
      return { handler: entry.handler(ctx), params };
    }
  }
  return null;
}

/**
 * List the resource descriptors surfaced by `resources/list`. PR #3
 * intentionally omits template expansion here (per the MCP spec, only
 * fixed URIs are listed, templates appear in `resources/templates/list`).
 */
export function listResourceDescriptors(): Array<{
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}> {
  return [
    {
      uri: "unimailbox://mailboxes",
      name: "mailboxes",
      description: "List mailboxes accessible by the principal.",
      mimeType: "application/json",
    },
  ];
}

/**
 * List the resource templates surfaced by `resources/templates/list`.
 * Exposed here so PR #4 can extend the dispatcher without re-touching
 * the resource module.
 */
export function listResourceTemplateDescriptors(): Array<{
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}> {
  return [
    {
      uriTemplate: "unimailbox://mailboxes",
      name: "mailboxes",
      description: "List mailboxes accessible by the principal.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "unimailbox://mailboxes/{mailbox_id}/messages",
      name: "mailbox_messages",
      description:
        "Preview-only list of messages in a mailbox (2 KiB cap per item).",
      mimeType: "application/json",
    },
    {
      uriTemplate: "unimailbox://messages/{message_id}",
      name: "message",
      description:
        "Preview of a single message (PII-redacted, body wrapped in untrusted-email sentinels).",
      mimeType: "application/json",
    },
    {
      uriTemplate: "unimailbox://threads/{thread_id}",
      name: "thread",
      description:
        "Aggregate of messages in a thread (preview-only, PII-redacted).",
      mimeType: "application/json",
    },
    {
      uriTemplate: "unimailbox://labels",
      name: "labels",
      description:
        "List of system labels (derived from mailbox folders) and user labels.",
      mimeType: "application/json",
    },
  ];
}

function matchTemplate(
  template: string,
  uri: string,
): Record<string, string> | null {
  const tplParts = template.split("/");
  const uriParts = uri.split("/");
  if (tplParts.length !== uriParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < tplParts.length; i += 1) {
    const tpl = tplParts[i];
    const value = uriParts[i];
    if (tpl === undefined || value === undefined) return null;
    if (tpl.startsWith("{") && tpl.endsWith("}")) {
      params[tpl.slice(1, -1)] = decodeURIComponent(value);
    } else if (tpl !== value) {
      return null;
    }
  }
  return params;
}
