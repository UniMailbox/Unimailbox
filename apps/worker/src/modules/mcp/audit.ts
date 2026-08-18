import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";

export type AuditDecision =
  | "success"
  | "rate_limited"
  | "forbidden"
  | "invalid_args"
  | "not_found"
  | "internal_error";

/**
 * Map an MCP tool / resource error code to the `AuditDecision` union. The
 * `not_found` bucket is intentionally separate from `internal_error` so
 * normal "principal can't see this resource" misses don't pollute the
 * internal-error dashboards.
 */
export function mapErrorToDecision(
  code: string,
): Exclude<AuditDecision, "success"> {
  switch (code) {
    case "rate_limited":
      return "rate_limited";
    case "forbidden":
      return "forbidden";
    case "invalid_args":
    case "confirmation_required":
    case "confirmation_invalid":
    case "idempotency_conflict":
      return "invalid_args";
    case "not_found":
      return "not_found";
    case "unauthorized":
    case "internal":
    default:
      return "internal_error";
  }
}

export interface AuditCallInput {
  tool: string;
  principal: Principal;
  args: unknown;
  decision: AuditDecision;
  durationMs: number;
  tokenId?: string;
  requestId: string;
  errorCode?: string;
}

/**
 * Shape-only projection of the args payload, per impl doc §5.8.
 *
 * We log keys + JSON-Schema-like types + length summaries, never the raw
 * values — that way the audit trail remains forensically useful while
 * keeping PII / message bodies out of the table. Object nesting is
 * flattened one level so `search_messages({ filter: { from: "..." } })`
 * still surfaces the `from` key without storing the address itself.
 */
function projectShape(value: unknown): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
    };
  }
  const type = typeof value;
  if (type !== "object") {
    return {
      type,
      length: type === "string" ? (value as string).length : undefined,
    };
  }
  const obj = value as Record<string, unknown>;
  const keys: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const inner = obj[key];
    if (inner === null) {
      keys[key] = { type: "null" };
    } else if (Array.isArray(inner)) {
      keys[key] = { type: "array", length: inner.length };
    } else {
      const innerType = typeof inner;
      keys[key] = {
        type: innerType,
        ...(innerType === "string" ? { length: (inner as string).length } : {}),
      };
    }
  }
  return { type: "object", keys };
}

/**
 * Persist a single MCP tool-call audit row.
 *
 * Failure to write the audit row never breaks the tool call — the row is
 * best-effort and runs `await ... .catch(() => undefined)` so a transient
 * D1 hiccup cannot 500 a successful request.
 */
export async function auditMcpCall(
  ctx: AppContext,
  input: AuditCallInput,
): Promise<void> {
  const metadata = {
    tool: input.tool,
    args_shape: projectShape(input.args),
    decision: input.decision,
    duration_ms: input.durationMs,
    ...(input.tokenId ? { token_id: input.tokenId } : {}),
    ...(input.errorCode ? { error_code: input.errorCode } : {}),
    principal_email_hash: hashPrincipalEmail(input.principal),
  };
  await ctx.env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_user_id, action, resource_type, resource_id,
       request_id, metadata_json
     ) VALUES (?, ?, 'mcp.tool_call', 'mcp_tool', ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      input.principal.userId,
      input.tool,
      input.requestId,
      JSON.stringify(metadata),
    )
    .run()
    .catch(() => undefined);
}

async function hashPrincipalEmail(principal: Principal): Promise<string> {
  const data = new TextEncoder().encode(principal.email);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
