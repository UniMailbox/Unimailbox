import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";

const KEY_PREFIX = "mcp:confirm:";
const DEFAULT_TTL_SECONDS = 300;
const CONSUMED_TTL_SECONDS = 60;

interface ConfirmationRecord {
  principal_id: string;
  payload: unknown;
  used: 0 | 1;
}

function key(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stable deep-equal for the payload fingerprint. Order-independent on the
 * top level (mirrors what JSON.stringify-on-both-sides would produce in
 * the impl doc), so adding new optional fields without re-issuing the
 * token does not invalidate an in-flight confirmation.
 */
function payloadFingerprint(payload: unknown): string {
  if (!isObject(payload)) return JSON.stringify(payload);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Create a confirmation token. The token id is a ULID-style identifier
 * (`crypto.randomUUID()` is sufficient until a ULID helper exists in the
 * shared package). The payload is JSON-serialised into KV with a TTL of
 * `ttlSec` (default 5 minutes, matching impl doc §5.5).
 *
 * Returns the id; callers must include it as `confirmation_token` in the
 * follow-up tool invocation.
 */
export async function createConfirmation(
  ctx: AppContext,
  principal: Principal,
  payload: unknown,
  ttlSec: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const id = crypto.randomUUID();
  const record: ConfirmationRecord = {
    principal_id: principal.userId,
    payload,
    used: 0,
  };
  await ctx.env.KV.put(key(id), JSON.stringify(record), {
    expirationTtl: Math.max(1, ttlSec),
  });
  return id;
}

/**
 * Mark a confirmation token as consumed.
 *
 * - Returns `false` when the token does not exist (TTL expiry).
 * - Returns `false` when the token was issued to a different principal.
 * - Returns `false` when the stored payload does not match
 *   `expectedPayload` (tamper detection — same shape, same values).
 * - Returns `false` when the token was already consumed.
 * - Returns `true` on first successful consume and persists a `used: 1`
 *   copy for `CONSUMED_TTL_SECONDS` to keep a window in which a
 *   double-spend attempt is observably rejected instead of looking like
 *   TTL expiry.
 */
export async function requireConfirmation(
  ctx: AppContext,
  principal: Principal,
  id: string,
  expectedPayload: unknown,
): Promise<boolean> {
  const raw = await ctx.env.KV.get(key(id));
  if (!raw) return false;
  let parsed: ConfirmationRecord;
  try {
    parsed = JSON.parse(raw) as ConfirmationRecord;
  } catch {
    return false;
  }
  if (parsed.used === 1) return false;
  if (parsed.principal_id !== principal.userId) return false;
  if (
    payloadFingerprint(parsed.payload) !== payloadFingerprint(expectedPayload)
  ) {
    return false;
  }
  await ctx.env.KV.put(key(id), JSON.stringify({ ...parsed, used: 1 }), {
    expirationTtl: CONSUMED_TTL_SECONDS,
  });
  return true;
}
