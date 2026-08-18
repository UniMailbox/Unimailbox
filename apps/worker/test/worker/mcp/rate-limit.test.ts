import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { checkRateLimit } from "../../../src/modules/mcp/rate-limit";
import { McpToolError } from "../../../src/modules/mcp/errors";

function kvStub(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return {
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
        cacheStatus: null,
      };
    },
    async getWithMetadata() {
      return { value: null, metadata: null, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.read"]),
};

describe("mcp rate limit", () => {
  let env: { KV: KVNamespace };
  let ctx: { env: { KV: KVNamespace } };

  beforeEach(() => {
    env = { KV: kvStub() };
    ctx = { env };
  });

  it("allows requests under the configured limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(
        checkRateLimit(ctx as never, principal, "read"),
      ).resolves.toBeUndefined();
    }
  });

  it("throws rate_limited once the cap is hit", async () => {
    const custom = 3;
    for (let i = 0; i < custom; i += 1) {
      await checkRateLimit(ctx as never, principal, "read", custom);
    }
    await expect(
      checkRateLimit(ctx as never, principal, "read", custom),
    ).rejects.toBeInstanceOf(McpToolError);
    await expect(
      checkRateLimit(ctx as never, principal, "read", custom),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("resets when the window rolls over", async () => {
    const custom = 2;
    const t0 = 1_700_000_000_000;
    await checkRateLimit(ctx as never, principal, "read", custom, t0);
    await checkRateLimit(ctx as never, principal, "read", custom, t0);
    await expect(
      checkRateLimit(ctx as never, principal, "read", custom, t0),
    ).rejects.toBeInstanceOf(McpToolError);
    // Advance past the 60s window: counter lives under the new window key.
    await expect(
      checkRateLimit(ctx as never, principal, "read", custom, t0 + 120_000),
    ).resolves.toBeUndefined();
  });
});
