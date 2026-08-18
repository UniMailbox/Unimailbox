import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../../app-context";
import type { McpToolContext } from "../context";

/**
 * Shared shape returned by every read tool factory. PR #3 narrows this to
 * the subset the dispatcher consumes; PR #4+ will extend it for
 * confirmation / idempotency wrappers.
 */
export interface ReadToolDef {
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

/**
 * Bag handed to each read tool handler. Mirrors `McpToolContext` but kept
 * narrow on purpose so the per-tool surface stays easy to mock.
 */
export interface ReadToolContext extends McpToolContext {
  modules: AppContext;
  principal: Principal;
  requestId: string;
}
