import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { idempotencyForMcp } from "../../../src/modules/mcp/idempotency";
import { McpToolError } from "../../../src/modules/mcp/errors";

interface RecordRow {
  request_hash: string;
  response_json: string;
}

function dbStub() {
  const records = new Map<string, RecordRow>();
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (!sql.includes("SELECT request_hash")) return null;
              const [actor, operation, key] = values as [
                string,
                string,
                string,
              ];
              return records.get(`${actor}:${operation}:${key}`) ?? null;
            },
            async run() {
              if (sql.includes("INSERT INTO idempotency_records")) {
                const [, actor, operation, key, hash, , responseJson] =
                  values as [
                    string,
                    string,
                    string,
                    string,
                    string,
                    number,
                    string,
                  ];
                records.set(`${actor}:${operation}:${key}`, {
                  request_hash: hash,
                  response_json: responseJson,
                });
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.send"]),
};

describe("mcp idempotency", () => {
  let env: { DB: D1Database };
  let ctx: { env: { DB: D1Database } };
  let run: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    env = { DB: dbStub() };
    ctx = { env };
    run = vi.fn();
  });

  it("runs and caches on first call", async () => {
    run.mockResolvedValueOnce({ ok: true });
    const result = await idempotencyForMcp(
      ctx as never,
      principal,
      "key-1",
      { to: ["a@b.test"] },
      run as never,
    );
    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("replays the cached result on identical key+payload", async () => {
    run.mockResolvedValueOnce({ ok: true });
    await idempotencyForMcp(
      ctx as never,
      principal,
      "key-2",
      { to: ["a@b.test"] },
      run as never,
    );
    run.mockClear();
    run.mockResolvedValueOnce({ ok: true, fresh: true });
    const replayed = await idempotencyForMcp(
      ctx as never,
      principal,
      "key-2",
      { to: ["a@b.test"] },
      run as never,
    );
    expect(run).not.toHaveBeenCalled();
    expect(replayed).toMatchObject({ ok: true, replayed: true });
  });

  it("throws idempotency_conflict on same key + different payload", async () => {
    run.mockResolvedValueOnce({ ok: true });
    await idempotencyForMcp(
      ctx as never,
      principal,
      "key-3",
      { to: ["a@b.test"] },
      run as never,
    );
    await expect(
      idempotencyForMcp(
        ctx as never,
        principal,
        "key-3",
        { to: ["evil@b.test"] },
        run as never,
      ),
    ).rejects.toBeInstanceOf(McpToolError);
    await expect(
      idempotencyForMcp(
        ctx as never,
        principal,
        "key-3",
        { to: ["evil@b.test"] },
        run as never,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("runs again when a fresh key is used", async () => {
    run.mockResolvedValueOnce({ ok: true });
    await idempotencyForMcp(
      ctx as never,
      principal,
      "key-4",
      { to: ["a@b.test"] },
      run as never,
    );
    run.mockClear();
    run.mockResolvedValueOnce({ ok: true, second: true });
    const result = await idempotencyForMcp(
      ctx as never,
      principal,
      "key-5",
      { to: ["a@b.test"] },
      run as never,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, replayed: false, second: true });
  });
});
