import {
  DomainError,
  PERMISSION_KEYS,
  type PermissionKey,
  type Principal,
} from "@unimailbox/contracts";
import type { Env } from "../../platform/config";
import { hashAgentToken } from "../mcp/auth";
import { assertPermission } from "../administration";

interface AgentTokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

/**
 * PR #8 — REST surface for issuing, listing, and revoking the long-lived
 * credentials that external AI agents present to the first-party MCP server.
 *
 * Plaintext tokens are 32 random bytes encoded as base64url — the same
 * primitive `TokenService.createRefreshToken` uses — and only the
 * SHA-256 hash (`hashAgentToken`) is persisted. That makes the lookup
 * in `mcp/auth.ts` an O(1) indexed query and means a forgotten plaintext
 * token cannot be recovered from the database: callers must rotate.
 *
 * The `user.manage` permission gates all three operations so an
 * administrator cannot issue tokens on behalf of another principal
 * (`identity.manage` per the spec doc §5.1, defaulting to the same
 * permission that already covers user administration).
 */
export class AgentTokenApplicationService {
  constructor(private readonly env: Env) {}

  async list(principal: Principal): Promise<AgentTokenView[]> {
    assertPermission(principal, "user.manage");
    const result = await this.env.DB.prepare(
      `SELECT id, user_id, name, scopes, created_at, last_used_at,
              expires_at, revoked_at
       FROM agent_tokens
       WHERE user_id = ?
       ORDER BY datetime(created_at, 'unixepoch') DESC, id DESC`,
    )
      .bind(principal.userId)
      .all<AgentTokenRow>();
    return (result.results ?? []).map(toView);
  }

  async create(
    principal: Principal,
    input: {
      name: string;
      scopes: readonly PermissionKey[];
      expires_at?: number | string | null;
    },
  ): Promise<{ view: AgentTokenView; plaintext: string }> {
    assertPermission(principal, "user.manage");
    const scopes = dedupeScopes(input.scopes);
    if (scopes.length === 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "At least one scope is required",
        400,
      );
    }
    const token = generateToken();
    const tokenHash = await hashAgentToken(token);
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = normaliseExpiry(input.expires_at);
    await this.env.DB.prepare(
      `INSERT INTO agent_tokens (
         id, user_id, name, token_hash, scopes,
         expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        principal.userId,
        input.name,
        tokenHash,
        JSON.stringify(scopes),
        expiresAt,
        createdAt,
      )
      .run();
    return {
      view: {
        id,
        name: input.name,
        scopes,
        created_at: createdAt,
        last_used_at: null,
        expires_at: expiresAt,
        revoked_at: null,
      },
      plaintext: token,
    };
  }

  async revoke(principal: Principal, tokenId: string): Promise<void> {
    assertPermission(principal, "user.manage");
    const existing = await this.env.DB.prepare(
      `SELECT id, user_id, revoked_at
       FROM agent_tokens WHERE id = ?`,
    )
      .bind(tokenId)
      .first<{ id: string; user_id: string; revoked_at: number | null }>();
    if (!existing || existing.user_id !== principal.userId) {
      throw new DomainError(
        "AGENT_TOKEN_NOT_FOUND",
        "Agent token not found",
        404,
      );
    }
    if (existing.revoked_at !== null) {
      throw new DomainError(
        "AGENT_TOKEN_ALREADY_REVOKED",
        "Agent token has already been revoked",
        409,
      );
    }
    await this.env.DB.prepare(
      `UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    )
      .bind(Date.now(), tokenId)
      .run();
  }
}

export interface AgentTokenView {
  id: string;
  name: string;
  scopes: PermissionKey[];
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function toView(row: AgentTokenRow): AgentTokenView {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

function dedupeScopes(scopes: readonly PermissionKey[]): PermissionKey[] {
  const known = new Set<string>(PERMISSION_KEYS);
  const out = new Set<PermissionKey>();
  for (const scope of scopes) {
    if (known.has(scope)) out.add(scope);
  }
  return [...out];
}

function parseScopes(raw: string): PermissionKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const known = new Set<string>(PERMISSION_KEYS);
  const out: PermissionKey[] = [];
  for (const value of parsed) {
    if (typeof value === "string" && known.has(value)) {
      out.push(value as PermissionKey);
    }
  }
  return out;
}

function normaliseExpiry(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
