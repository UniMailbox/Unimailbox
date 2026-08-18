import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import {
  createConfirmation,
  requireConfirmation,
} from "../../../src/modules/mcp/confirmation";

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
  permissions: new Set(["message.send"]),
};

describe("mcp confirmation store", () => {
  let env: { KV: KVNamespace };
  let ctx: { env: { KV: KVNamespace } };

  beforeEach(() => {
    env = { KV: kvStub() };
    ctx = { env };
  });

  it("returns true on first valid consume", async () => {
    const id = await createConfirmation(ctx as never, principal, {
      to: ["a@b.test"],
    });
    const ok = await requireConfirmation(ctx as never, principal, id, {
      to: ["a@b.test"],
    });
    expect(ok).toBe(true);
  });

  it("returns false on the second consume (single-use)", async () => {
    const id = await createConfirmation(ctx as never, principal, {
      to: ["a@b.test"],
    });
    expect(
      await requireConfirmation(ctx as never, principal, id, {
        to: ["a@b.test"],
      }),
    ).toBe(true);
    expect(
      await requireConfirmation(ctx as never, principal, id, {
        to: ["a@b.test"],
      }),
    ).toBe(false);
  });

  it("returns false on a different payload (tamper detection)", async () => {
    const id = await createConfirmation(ctx as never, principal, {
      to: ["a@b.test"],
    });
    const ok = await requireConfirmation(ctx as never, principal, id, {
      to: ["evil@b.test"],
    });
    expect(ok).toBe(false);
  });

  it("returns false on TTL expiry", async () => {
    // Store a record with a 1-second TTL, then mutate the underlying KV
    // to simulate expiry (the stub doesn't honour TTL automatically).
    const id = await createConfirmation(
      ctx as never,
      principal,
      {
        to: ["a@b.test"],
      },
      1,
    );
    await env.KV.delete(`mcp:confirm:${id}`);
    const ok = await requireConfirmation(ctx as never, principal, id, {
      to: ["a@b.test"],
    });
    expect(ok).toBe(false);
  });

  it("rejects tokens issued to a different principal", async () => {
    const id = await createConfirmation(ctx as never, principal, {
      to: ["a@b.test"],
    });
    const intruder: Principal = {
      ...principal,
      userId: "user-2",
    };
    const ok = await requireConfirmation(ctx as never, intruder, id, {
      to: ["a@b.test"],
    });
    expect(ok).toBe(false);
  });
});
