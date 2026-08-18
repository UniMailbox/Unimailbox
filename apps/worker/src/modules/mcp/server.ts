import type { PermissionKey } from "@unimailbox/contracts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppContext } from "../../app-context";
import { assertScope } from "./auth";
import { auditMcpCall, mapErrorToDecision } from "./audit";
import type { McpToolContext } from "./context";
import { McpToolError, toMcpResult } from "./errors";
import { checkRateLimit, type RateLimitKind } from "./rate-limit";
import {
  listResourceDescriptors,
  listResourceTemplateDescriptors,
  matchResourceTemplate,
} from "./resources";
import { HelloMcpInputSchema, type HelloMcpInput } from "./schema";
import { getMessageTool } from "./tools/get-message";
import { listMessagesTool } from "./tools/list-messages";
import { listThreadsTool } from "./tools/list-threads";
import { searchMessagesTool } from "./tools/search-messages";
import {
  draftMessageTool,
  sendMessageTool,
  shapeArgsForAudit,
} from "./tools/write-common";
import {
  archiveMessageTool,
  forwardMessageTool,
  markAsReadTool,
  markAsStarredTool,
  moveMessageTool,
  replyMessageTool,
  trashMessageTool,
} from "./tools/write-tools";
import {
  cancelScheduledTool,
  scheduleMessageTool,
} from "./tools/schedule-tools";
import {
  downloadAttachmentTool,
  listAttachmentsTool,
} from "./tools/attachment-tools";
import {
  summarizeThreadTool,
  classifyMessageTool,
  extractActionItemsTool,
} from "./tools/ai-tools";

/**
 * JSON-RPC 2.0 message shapes we care about. Kept minimal so PR #2
 * does not pull in `ajv` (which the @modelcontextprotocol/sdk's
 * high-level `McpServer` class transitively imports, and which the
 * workerd runtime cannot resolve under the vitest-pool-workers test
 * pool). PR #3+ may upgrade to the full SDK once a JSON-import-safe
 * validator is wired in.
 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    extra: { sessionId: string | null; requestId: string },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

interface McpServerLike {
  handleRequest(request: Request): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Build a fresh MCP server per request. The transport is the SDK's
 * `WebStandardStreamableHTTPServerTransport` (no ajv dependency); the
 * dispatch layer is hand-rolled and only routes the three methods PR
 * #2 needs (`initialize`, `tools/list`, `tools/call`).
 *
 * The returned object exposes just enough surface for the entrypoint
 * (`handleRequest`, `close`). Business-logic tools land in PR #3+.
 */
export function buildMcpServer(ctx: McpToolContext): McpServerLike {
  const tools = new Map<string, ToolDefinition>();
  tools.set("hello_mcp", {
    name: "hello_mcp",
    description:
      "Returns a greeting from the UniMailbox first-party MCP server. " +
      "PR #2 placeholder; business-logic tools land in PR #3+.",
    inputSchema: zodToJsonSchema(HelloMcpInputSchema),
    handler: async (args, extra) => {
      const started = Date.now();
      const parsed = HelloMcpInputSchema.safeParse(args);
      if (!parsed.success) {
        await auditMcpCall(ctx.modules, {
          tool: "hello_mcp",
          principal: ctx.principal,
          args,
          decision: "invalid_args",
          durationMs: Date.now() - started,
          requestId: ctx.requestId,
          errorCode: "invalid_args",
        });
        return {
          ...toMcpResult(
            new McpToolError("invalid_args", undefined, parsed.error.flatten()),
          ),
        };
      }
      const greeting = parsed.data.name ?? "world";
      const payload = {
        message: `hello, ${greeting}`,
        version: "0.1.0",
        principal_id: ctx.principal.userId,
        session_id: extra.sessionId,
        request_id: ctx.requestId,
      };
      await auditMcpCall(ctx.modules, {
        tool: "hello_mcp",
        principal: ctx.principal,
        args: parsed.data,
        decision: "success",
        durationMs: Date.now() - started,
        requestId: ctx.requestId,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  });

  // PR #3: read-only tools land here. Every handler runs `assertScope`
  // and `checkRateLimit` before any DB read, and writes an audit row
  // with the shape-only args projection.
  for (const factory of [
    listMessagesTool,
    searchMessagesTool,
    getMessageTool,
    listThreadsTool,
  ]) {
    const tool = factory(ctx);
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (args, extra) => {
        const started = Date.now();
        try {
          assertScope(ctx.principal, ["message.read"]);
          await checkRateLimit(ctx.modules, ctx.principal, "read");
          const result = await tool.handler(args, extra);
          await auditMcpCall(ctx.modules, {
            tool: tool.name,
            principal: ctx.principal,
            args,
            decision: "success",
            durationMs: Date.now() - started,
            requestId: ctx.requestId,
          });
          return result;
        } catch (error) {
          const code =
            error instanceof McpToolError ? error.code : "internal_error";
          await auditMcpCall(ctx.modules, {
            tool: tool.name,
            principal: ctx.principal,
            args,
            decision: mapErrorToDecision(code),
            durationMs: Date.now() - started,
            requestId: ctx.requestId,
            errorCode: code,
          });
          throw error;
        }
      },
    });
  }

  // AI read tools use a separate cost-aware rate limit and two scopes.
  for (const factory of [
    summarizeThreadTool,
    classifyMessageTool,
    extractActionItemsTool,
  ]) {
    const tool = factory(ctx);
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (args, extra) => {
        const started = Date.now();
        try {
          assertScope(ctx.principal, ["message.read", "ai.read"]);
          await checkRateLimit(ctx.modules, ctx.principal, "ai");
          const result = await tool.handler(args, extra);
          await auditMcpCall(ctx.modules, {
            tool: tool.name,
            principal: ctx.principal,
            args: shapeArgsForAudit(args),
            decision: "success",
            durationMs: Date.now() - started,
            requestId: ctx.requestId,
          });
          return result;
        } catch (error) {
          const code =
            error instanceof McpToolError ? error.code : "internal_error";
          await auditMcpCall(ctx.modules, {
            tool: tool.name,
            principal: ctx.principal,
            args: shapeArgsForAudit(args),
            decision: mapErrorToDecision(code),
            durationMs: Date.now() - started,
            requestId: ctx.requestId,
            errorCode: code,
          });
          throw error;
        }
      },
    });
  }

  // PR #4 write tools. Security policy lives at this dispatcher boundary so
  // every invocation is scoped, rate-limited, and audited consistently.
  for (const factory of [
    sendMessageTool,
    draftMessageTool,
    replyMessageTool,
    forwardMessageTool,
    markAsReadTool,
    markAsStarredTool,
    moveMessageTool,
    archiveMessageTool,
    trashMessageTool,
    // PR #5 schedule tools. `schedule_message` requires `message.send` AND
    // `schedule.write` so an agent with only the send scope cannot enqueue
    // future sends; `cancel_scheduled` only needs `schedule.write` because
    // revoking your own schedule is never a `message.send` operation.
    scheduleMessageTool,
    cancelScheduledTool,
    // PR #5 attachment tools. The dispatcher applies the read-style scope
    // check + rate limit at this boundary; the `download_attachment`
    // default-off guard lives inside the tool handler itself so the
    // `list_attachments` call still works for every caller.
    listAttachmentsTool,
    downloadAttachmentTool,
  ]) {
    const tool = factory(ctx);
    tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (args, extra) => {
        const started = Date.now();
        const policy = writeToolPolicy(tool.name);
        try {
          assertScope(ctx.principal, policy.scopes);
          await checkRateLimit(ctx.modules, ctx.principal, policy.rateLimit);
          const result = await tool.handler(args, extra);
          await auditMcpCall(ctx.modules, {
            tool: tool.name,
            principal: ctx.principal,
            args: shapeArgsForAudit(args),
            decision: "success",
            durationMs: Date.now() - started,
            requestId: ctx.requestId,
          });
          return result;
        } catch (error) {
          const code =
            error instanceof McpToolError ? error.code : "internal_error";
          await auditMcpCall(ctx.modules, {
            tool: tool.name,
            principal: ctx.principal,
            args: shapeArgsForAudit(args),
            decision: mapErrorToDecision(code),
            durationMs: Date.now() - started,
            requestId: ctx.requestId,
            errorCode: code,
          });
          throw error;
        }
      },
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    // JSON mode lets the transport wait for every response before the
    // HTTP body is finalised, which lines up with our synchronous
    // request/response dispatch model. SSE mode would race the test
    // harness (which reads the body to EOF before the async onmessage
    // dispatch has a chance to enqueue events).
    enableJsonResponse: true,
  });
  let closed = false;

  transport.onmessage = async (message) => {
    if (!isRequest(message)) return;
    await dispatch(message, ctx, tools, transport, ctx.requestId);
  };

  return {
    async handleRequest(request: Request): Promise<Response> {
      try {
        return await transport.handleRequest(request);
      } finally {
        if (!closed) {
          closed = true;
          try {
            await transport.close();
          } catch {
            // best-effort close
          }
        }
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await transport.close();
      } catch {
        // best-effort close
      }
    },
  };
}

function writeToolPolicy(toolName: string): {
  scopes: readonly PermissionKey[];
  rateLimit: RateLimitKind;
} {
  switch (toolName) {
    case "send_message":
    case "reply_message":
    case "forward_message":
      return { scopes: ["message.send"], rateLimit: "send" };
    case "schedule_message":
      // Schedule write is gated behind the `schedule.write` scope in
      // addition to `message.send` (impl doc §4.2): revoking either
      // permission should make the tool unusable, and `schedule.write`
      // is what distinguishes scheduled sends from regular writes.
      return { scopes: ["message.send", "schedule.write"], rateLimit: "send" };
    case "draft_message":
      return { scopes: ["message.send"], rateLimit: "write" };
    case "cancel_scheduled":
      // Cancel only needs the `schedule.write` scope — the user's own
      // scheduled send can be revoked without holding `message.send`.
      return { scopes: ["schedule.write"], rateLimit: "write" };
    case "mark_as_read":
    case "mark_as_starred":
      return { scopes: ["message.read"], rateLimit: "write" };
    case "move_message":
    case "archive_message":
    case "trash_message":
      return { scopes: ["message.delete"], rateLimit: "write" };
    case "list_attachments":
    case "download_attachment":
      // Attachment metadata + binary download both gate on the read
      // pair. The default-off guard for binary downloads lives inside
      // the tool handler so the metadata call stays available to every
      // caller that holds `attachment.read`.
      return { scopes: ["message.read", "attachment.read"], rateLimit: "read" };
    default:
      throw new McpToolError(
        "internal",
        `Missing write policy for ${toolName}`,
      );
  }
}

function extractMailboxIdFromUri(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "unimailbox:") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname === "mailboxes" && segments.length > 0) {
    return decodeURIComponent(segments[0]);
  }
  if (
    ["messages", "threads", "drafts", "attachments"].includes(
      parsed.hostname,
    ) &&
    segments.length > 0
  ) {
    return decodeURIComponent(segments[0]);
  }
  return null;
}

function isRequest(message: unknown): message is JsonRpcRequest {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  return (
    m.jsonrpc === "2.0" &&
    typeof m.method === "string" &&
    (typeof m.id === "number" || typeof m.id === "string")
  );
}

async function dispatch(
  request: JsonRpcRequest,
  ctx: McpToolContext,
  tools: Map<string, ToolDefinition>,
  transport: WebStandardStreamableHTTPServerTransport,
  requestId: string,
): Promise<void> {
  const respond = async (response: JsonRpcResponse) => {
    try {
      await transport.send(response as never, {
        relatedRequestId: request.id as never,
      });
    } catch {
      // Swallow: response channel may already be closed by the transport.
    }
  };

  try {
    if (request.method === "initialize") {
      await respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "unimailbox", version: "0.1.0" },
        },
      });
      return;
    }
    if (request.method === "tools/list") {
      await respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: Array.from(tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const tool = tools.get(params.name ?? "");
      if (!tool) {
        await respond({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: `Unknown tool: ${params.name ?? ""}`,
          },
        });
        return;
      }
      try {
        const result = await tool.handler(params.arguments ?? {}, {
          sessionId: null,
          requestId,
        });
        await respond({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        if (error instanceof McpToolError) {
          await respond({
            jsonrpc: "2.0",
            id: request.id,
            result: toMcpResult(error),
          });
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === "resources/list") {
      await respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resources: listResourceDescriptors(),
        },
      });
      return;
    }
    if (request.method === "resources/templates/list") {
      await respond({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          resourceTemplates: listResourceTemplateDescriptors(),
        },
      });
      return;
    }
    if (
      request.method === "resources/subscribe" ||
      request.method === "resources/unsubscribe"
    ) {
      const params = request.params ?? {};
      const uri = params.uri;
      const mailboxId =
        typeof uri === "string" ? extractMailboxIdFromUri(uri) : null;
      if (!mailboxId) {
        await respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Invalid resource URI" },
        });
        return;
      }
      const started = Date.now();
      try {
        assertScope(ctx.principal, ["message.read"]);
        const namespace = ctx.env.MAILBOX_AGENT;
        if (!namespace)
          throw new McpToolError("internal", "Mailbox agent unavailable");
        namespace.get(namespace.idFromName(mailboxId));
        await auditMcpCall(ctx.modules, {
          tool: request.method,
          principal: ctx.principal,
          args: { uri },
          decision: "success",
          durationMs: Date.now() - started,
          requestId: ctx.requestId,
        });
        await respond({
          jsonrpc: "2.0",
          id: request.id,
          result: { ok: true },
        });
      } catch (error) {
        const code =
          error instanceof McpToolError ? error.code : "internal_error";
        await auditMcpCall(ctx.modules, {
          tool: request.method,
          principal: ctx.principal,
          args: { uri },
          decision: mapErrorToDecision(code),
          durationMs: Date.now() - started,
          requestId: ctx.requestId,
          errorCode: code,
        });
        throw error;
      }
      return;
    }
    if (request.method === "resources/read") {
      const params = (request.params ?? {}) as { uri?: string };
      const uri = params.uri;
      if (!uri) {
        await respond({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Missing uri parameter" },
        });
        return;
      }
      const matched = matchResourceTemplate(ctx.modules, uri);
      if (!matched) {
        await respond({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: `Unknown resource URI: ${uri}`,
          },
        });
        return;
      }
      const started = Date.now();
      try {
        assertScope(ctx.principal, ["message.read"]);
        await checkRateLimit(ctx.modules, ctx.principal, "read");
        const contents = await matched.handler.read(
          ctx.principal,
          matched.params,
        );
        await auditMcpCall(ctx.modules, {
          tool: `resources/read:${uri}`,
          principal: ctx.principal,
          args: { uri },
          decision: "success",
          durationMs: Date.now() - started,
          requestId: ctx.requestId,
        });
        await respond({ jsonrpc: "2.0", id: request.id, result: contents });
      } catch (error) {
        const code =
          error instanceof McpToolError ? error.code : "internal_error";
        await auditMcpCall(ctx.modules, {
          tool: `resources/read:${uri}`,
          principal: ctx.principal,
          args: { uri },
          decision: mapErrorToDecision(code),
          durationMs: Date.now() - started,
          requestId: ctx.requestId,
          errorCode: code,
        });
        if (error instanceof McpToolError) {
          const payload = toMcpResult(error);
          await respond({
            jsonrpc: "2.0",
            id: request.id,
            result: payload,
          });
          return;
        }
        throw error;
      }
      return;
    }
    if (request.method === "ping") {
      await respond({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    await respond({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    });
  } catch (error) {
    await respond({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
    });
  }
}

/**
 * Minimal Zod → JSON Schema conversion for the placeholder tool. Only
 * covers what `HelloMcpInputSchema` actually emits — sufficient for PR
 * #2, intentionally not a generic converter. PR #3+ will replace this
 * with the SDK's full conversion once `ajv` is no longer in the
 * critical path.
 */
function zodToJsonSchema(schema: { shape: Record<string, unknown> }): {
  type: "object";
  properties: Record<string, unknown>;
  additionalProperties: boolean;
} {
  const properties: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema.shape)) {
    const desc = (def as { description?: string }).description;
    properties[key] = desc
      ? { type: "string", description: desc }
      : { type: "string" };
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

// Reference HelloMcpInput so unused-import warnings stay quiet; the
// type is intentionally exposed for tool handlers in PR #3+.
export type { HelloMcpInput };

export type { AppContext };
