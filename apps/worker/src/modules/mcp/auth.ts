import {
  PERMISSION_KEYS,
  type PermissionKey,
  type Principal,
} from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";
import { hashRefreshToken } from "../identity";
import { McpToolError } from "./errors";

interface AgentTokenRow {
  id: string;
  user_id: string;
  scopes: string;
  expires_at: number | null;
  revoked_at: number | null;
}

interface UserRow {
  email: string;
  status: string;
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/iu);
  return match?.[1] ?? null;
}

function parseScopes(raw: string): Set<PermissionKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const declared = new Set<string>(PERMISSION_KEYS);
  const out = new Set<PermissionKey>();
  for (const value of parsed) {
    if (typeof value === "string" && declared.has(value)) {
      out.add(value as PermissionKey);
    }
  }
  return out;
}

/**
 * Authenticate a Streamable HTTP request. Order is fixed:
 *
 * 1. `agent_token` — long-lived credentials from the `agent_tokens` table
 *    (PR #1 migration `0010_agent_tokens.sql`). Verified via SHA-256 hash
 *    lookup so the database query is O(1) regardless of how many tokens the
 *    principal has issued. Token issuance (PR #3) must call
 *    `hashAgentToken(plaintext)` and store the result in `token_hash`.
 * 2. JWT access token — same verifier the HTTP router uses.
 *
 * `WWW-Authenticate` is added by the entrypoint when this throws
 * `unauthorized` so a 401 is MCP-spec compliant (RFC 9728 §5.1).
 */
export async function authenticate(
  ctx: AppContext,
  request: Request,
): Promise<Principal> {
  const token = parseBearer(request.headers.get("authorization"));
  if (!token) {
    throw new McpToolError("unauthorized");
  }

  const agent = await verifyAgentToken(ctx, token);
  if (agent) return agent;

  try {
    return await ctx.identity.verifyAccessToken(token);
  } catch {
    throw new McpToolError("unauthorized");
  }
}

async function verifyAgentToken(
  ctx: AppContext,
  token: string,
): Promise<Principal | null> {
  const tokenHash = await hashAgentToken(token);
  const candidate = await ctx.env.DB.prepare(
    `SELECT id, user_id, scopes, expires_at, revoked_at
     FROM agent_tokens
     WHERE token_hash = ? AND revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(tokenHash)
    .first<AgentTokenRow>();
  if (!candidate) return null;
  const now = Date.now();
  if (typeof candidate.expires_at === "number" && candidate.expires_at < now) {
    return null;
  }
  const scopes = parseScopes(candidate.scopes);
  // Best-effort last_used_at bump; failure must not block auth.
  ctx.env.DB.prepare(`UPDATE agent_tokens SET last_used_at = ? WHERE id = ?`)
    .bind(now, candidate.id)
    .run()
    .catch(() => undefined);
  const user = await ctx.env.DB.prepare(
    `SELECT email, status FROM users WHERE id = ?`,
  )
    .bind(candidate.user_id)
    .first<UserRow>();
  if (user?.status === "suspended") {
    throw new McpToolError("forbidden", "Account is suspended");
  }
  return {
    userId: candidate.user_id,
    email: user?.email ?? "",
    permissions: scopes,
  };
}

/**
 * Throw `forbidden` if the principal is missing any of the required
 * permission keys. Callers should run this inside the tool handler after
 * authentication, before touching any data plane.
 */
export function assertScope(
  principal: Principal,
  required: readonly PermissionKey[],
): void {
  for (const key of required) {
    if (!principal.permissions.has(key)) {
      throw new McpToolError("forbidden", undefined, { required: key });
    }
  }
}

/**
 * SHA-256 hash of the presented plaintext agent token, base64url encoded.
 * The migration `0010_agent_tokens.sql` already has a `token_hash` column;
 * issuance (PR #3) writes this exact value into that column so the auth
 * path can match in O(1) with a single indexed query.
 *
 * Reuses `hashRefreshToken` to keep all token-hash derivations consistent.
 * Tokens are 32+ random bytes, so SHA-256 is sufficient to defeat brute
 * force against a database dump.
 */
export const hashAgentToken = hashRefreshToken;

export { parseBearer as _parseBearerForTests };
