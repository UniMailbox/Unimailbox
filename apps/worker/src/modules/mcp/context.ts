import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";
import { authenticate } from "./auth";

/**
 * Bag passed to every MCP tool handler. Keeps the tool surface area
 * stable while letting each PR layer in additional fields (resource
 * handles, mailbox context, agent DO references, etc.).
 */
export interface McpToolContext {
  /** Authenticated caller. Tool handlers should never re-authenticate. */
  principal: Principal;
  /** Stable per-request id, surfaced in logs and the `x-request-id` header. */
  requestId: string;
  /** Worker Env — same surface as `AppContext.env`, narrowed to what tools need. */
  env: AppContext["env"];
  /** AppContext for service-layer access (modules, logger, …). */
  modules: AppContext;
}

/**
 * Build the per-request MCP context. Centralises the auth + request-id
 * plumbing so the SDK entrypoint stays one line long.
 *
 * `request_id` precedence: explicit `x-request-id` header (already set by
 * Hono's middleware when the request flows through the HTTP router),
 * else `cf-ray` (Cloudflare's request fingerprint), else a fresh UUID.
 */
export async function buildMcpContext(
  request: Request,
  env: AppContext["env"],
  modules: AppContext,
): Promise<McpToolContext> {
  const principal = await authenticate(modules, request);
  const requestId =
    request.headers.get("x-request-id") ??
    request.headers.get("cf-ray") ??
    crypto.randomUUID();
  return {
    principal,
    requestId,
    env,
    modules,
  };
}
