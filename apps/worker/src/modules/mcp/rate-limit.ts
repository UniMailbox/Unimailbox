import type { Principal } from "@unimailbox/contracts";
import type { AppContext } from "../../app-context";
import { McpToolError } from "./errors";

/**
 * MCP rate limit tiers. The defaults mirror impl doc §2.7 and §5.3; a
 * caller can pass `customPerMin` to tighten a single tool without
 * redefining the whole tier (used by `send_message`'s tighter 10/min cap).
 */
const LIMITS = {
  read: { per_min: 60 },
  write: { per_min: 10 },
  ai: { per_min: 20 },
  send: { per_min: 10 },
} as const satisfies Record<string, { per_min: number }>;

export type RateLimitKind = keyof typeof LIMITS;

const WINDOW_SECONDS = 60;
const TTL_SECONDS = 120; // 2 × window — see apps/worker/src/platform/rate-limit.ts

function windowKey(
  kind: RateLimitKind,
  principal: Principal,
  now: number,
): string {
  return `rate:mcp:${kind}:${principal.userId}:${Math.floor(now / 1000 / WINDOW_SECONDS)}`;
}

/**
 * Check (and increment) the per-user MCP rate counter for `kind`.
 *
 * Throws `rate_limited` when the configured per-minute cap is exceeded.
 * The counter lives in the existing KV namespace under
 * `rate:mcp:<kind>:<userId>:<windowIndex>` so it shares TTL semantics
 * with the rest of the rate-limit code in `apps/worker/src/platform/rate-limit.ts`.
 */
export async function checkRateLimit(
  ctx: AppContext,
  principal: Principal,
  kind: RateLimitKind,
  customPerMin?: number,
  now: number = Date.now(),
): Promise<void> {
  const cfg = LIMITS[kind];
  const limit = customPerMin ?? cfg.per_min;
  const key = windowKey(kind, principal, now);
  const raw = await ctx.env.KV.get(key);
  const current = Number.parseInt(raw ?? "0", 10);
  const count = Number.isFinite(current) && current > 0 ? current : 0;
  if (count >= limit) {
    throw new McpToolError(
      "rate_limited",
      `Too many ${kind} requests; limit is ${limit}/min`,
    );
  }
  await ctx.env.KV.put(key, String(count + 1), {
    expirationTtl: TTL_SECONDS,
  });
}
