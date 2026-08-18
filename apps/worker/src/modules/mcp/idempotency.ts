import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";
import { requestHash } from "../../http/admin-idempotency";
import { McpToolError } from "./errors";

interface IdempotencyRecordRow {
  request_hash: string;
  response_json: string;
}

/**
 * Result returned by a cached idempotent call: the caller should replay
 * this instead of running the underlying tool body a second time.
 */
export interface IdempotentReplay {
  status: number;
  body: string;
  contentType: string | null;
  replayed: boolean;
}

const OPERATION_PREFIX = "mcp:tool";

function namespaceKey(principal: Principal, key: string): string {
  return `${principal.userId}:${key}`;
}

/**
 * Wrap a tool body in idempotency semantics for the first-party MCP server.
 *
 * - Reuses `idempotency_records` from `apps/worker/src/http/admin-idempotency.ts`
 *   so the schema, TTL, and replay semantics stay identical between the
 *   REST admin API and the MCP surface.
 * - The namespace prefix is `mcp:<userId>:<idempotencyKey>` to keep the
 *   keys collision-free with admin callers.
 * - The payload fingerprint is `SHA-256(JSON.stringify({ operation, body }))`
 *   — different payload under the same key throws `idempotency_conflict`
 *   so retried-but-mutated requests do not silently succeed.
 *
 * Returns the result either from cache (`replayed: true`) or from the
 * freshly-executed `run` callback (`replayed: false`). The callback is
 * expected to throw on failure; only successful results are cached.
 */
export async function idempotencyForMcp<T>(
  ctx: AppContext,
  principal: Principal,
  key: string,
  payload: unknown,
  run: () => Promise<T>,
): Promise<T & { replayed: boolean }> {
  const operation = `${OPERATION_PREFIX}:${namespaceKey(principal, key)}`;
  const hash = await requestHash(
    JSON.stringify({ operation, body: payload ?? null }),
  );

  const existing = await ctx.env.DB.prepare(
    `SELECT request_hash, response_json
     FROM idempotency_records
     WHERE actor_user_id = ? AND operation = ? AND idempotency_key = ?
       AND expires_at > CURRENT_TIMESTAMP`,
  )
    .bind(principal.userId, operation, key)
    .first<IdempotencyRecordRow>();

  if (existing) {
    if (existing.request_hash !== hash) {
      throw new McpToolError(
        "idempotency_conflict",
        "The idempotency key was reused with a different payload",
      );
    }
    try {
      const replay = JSON.parse(existing.response_json) as {
        body: string;
        status: number;
        contentType: string | null;
      };
      return {
        ...(JSON.parse(replay.body) as T),
        replayed: true,
      } as T & { replayed: boolean };
    } catch {
      // Corrupt cache row — fall through and re-run, then overwrite.
    }
  }

  const result = await run();
  const body = JSON.stringify(result);
  await ctx.env.DB.prepare(
    `INSERT INTO idempotency_records (
       id, actor_user_id, operation, idempotency_key, request_hash,
       response_status, response_json, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 day'))`,
  )
    .bind(
      crypto.randomUUID(),
      principal.userId,
      operation,
      key,
      hash,
      200,
      JSON.stringify({
        body,
        status: 200,
        contentType: "application/json",
      }),
    )
    .run()
    .catch(() => undefined);
  return { ...(result as object), replayed: false } as T & {
    replayed: boolean;
  };
}
