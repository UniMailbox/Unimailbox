import { createAppContext } from "../app-context";
import { McpToolError } from "../modules/mcp/errors";
import { buildMcpContext } from "../modules/mcp/context";
import { buildMcpServer } from "../modules/mcp/server";
import type { Env } from "../platform/config";

/**
 * Runtime feature flag. Defaults to disabled so the route stays cold
 * until the operator flips it on. PR #8 wires this through the
 * `system_settings` row so it can be toggled without a redeploy.
 *
 * `globalThis.MCP_ENABLED` lets the integration test pool force-enable
 * the route without mutating wrangler config.
 */
declare global {
  // eslint-disable-next-line no-var
  var MCP_ENABLED: boolean | undefined;
}
function isMcpEnabled(): boolean {
  return typeof globalThis !== "undefined" && globalThis.MCP_ENABLED === true;
}

/**
 * Stateless Streamable HTTP handler for the first-party MCP server.
 *
 * PR #2 wires the route, the auth gate, the stateless transport, and a
 * single placeholder tool. Subsequent PRs add business-logic tools on
 * the same `buildMcpServer` factory.
 *
 * The route MUST be stateless (no `Mcp-Session-Id` management) per the
 * 2026-07-28 MCP spec recommendation and impl doc §2.1. Every request
 * spins up a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport`
 * pair so concurrent clients cannot leak tool state.
 *
 * Mounted as a sub-route on the Hono router in
 * `apps/worker/src/http/router.ts` (Strategy A) so the existing
 * bootstrap gate, request-id header, and CORS handling stay shared.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  executionCtx?: ExecutionContext<unknown>,
): Promise<Response> {
  if (!isMcpEnabled()) {
    return new Response("MCP endpoint disabled", { status: 404 });
  }
  let mcpContext;
  try {
    const modules = await createAppContext(env, executionCtx);
    mcpContext = await buildMcpContext(request, env, modules);
  } catch (error) {
    if (error instanceof McpToolError && error.code === "unauthorized") {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
          },
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate":
              'Bearer realm="unimailbox", error="invalid_token"',
          },
        },
      );
    }
    throw error;
  }

  const server = buildMcpServer(mcpContext);
  try {
    return await server.handleRequest(request);
  } finally {
    // Best-effort close: tear down any per-request state the server
    // accumulated so the worker does not leak memory across calls.
    try {
      await server.close();
    } catch {
      // Swallow: close is idempotent and best-effort.
    }
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    return handleMcpRequest(request, env, context);
  },
} satisfies ExportedHandler<Env>;
