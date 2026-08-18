import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { TokenService } from "../../../src/modules/identity";
import { hashRefreshToken } from "../../../src/modules/identity";
import {
  _parseBearerForTests,
  authenticate,
  assertScope,
  hashAgentToken,
} from "../../../src/modules/mcp/auth";
import { McpToolError } from "../../../src/modules/mcp/errors";

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

interface DbStubOptions {
  /** When set, only the row whose token_hash matches the query is returned. */
  tokensByHash?: Map<string, AgentTokenRow>;
  user?: UserRow;
}

function dbStub(opts: DbStubOptions = {}) {
  const user = opts.user ?? { email: "owner@example.com", status: "active" };
  const tokensByHash = opts.tokensByHash ?? new Map<string, AgentTokenRow>();
  return {
    prepare(sql: string) {
      const statement = {
        bind(...values: unknown[]) {
          (statement as unknown as { _values: unknown[] })._values = values;
          return statement;
        },
        async first<T>() {
          if (sql.includes("SELECT email, status FROM users")) {
            return user as unknown as T;
          }
          if (sql.includes("FROM agent_tokens")) {
            const values = (statement as unknown as { _values: unknown[] })
              ._values;
            const tokenHash = values[0] as string;
            const row = tokensByHash.get(tokenHash);
            return (row ?? null) as unknown as T;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function makeCtx(
  db: D1Database,
  verify: (token: string) => Promise<Principal>,
) {
  return {
    env: { DB: db },
    identity: {
      verifyAccessToken: vi.fn(verify),
    },
  } as never;
}

describe("mcp authenticate", () => {
  let verify: (token: string) => Promise<Principal>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    verify = vi.fn(async (token: string) => {
      throw new Error(`unexpected JWT verify for ${token}`);
    });
    ctx = makeCtx(dbStub(), verify);
  });

  it("rejects requests without a Bearer header", async () => {
    await expect(
      authenticate(ctx, new Request("https://example.com/mcp")),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects requests with a malformed Authorization header", async () => {
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: "Token abc" },
    });
    await expect(authenticate(ctx, request)).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("falls through to JWT when no agent_token matches", async () => {
    const principal: Principal = {
      userId: "user-1",
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    };
    verify = vi.fn(async () => principal);
    ctx = makeCtx(dbStub(), verify);
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: "Bearer jwt-foo" },
    });
    await expect(authenticate(ctx, request)).resolves.toEqual(principal);
  });

  it("falls through to JWT when an agent_token row exists but the secret does not match", async () => {
    const principal: Principal = {
      userId: "user-1",
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    };
    const storedHash = await hashAgentToken("the-real-plaintext");
    const tokensByHash = new Map<string, AgentTokenRow>([
      [
        storedHash,
        {
          id: "tok-1",
          user_id: "user-1",
          scopes: JSON.stringify(["message.read"]),
          expires_at: null,
          revoked_at: null,
        },
      ],
    ]);
    verify = vi.fn(async () => principal);
    ctx = makeCtx(dbStub({ tokensByHash }), verify);
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: "Bearer wrong-plaintext" },
    });
    await expect(authenticate(ctx, request)).resolves.toEqual(principal);
  });

  it("validates an agent_token via SHA-256 hash lookup", async () => {
    const plaintext = "sk-mcp-very-secret-token";
    const storedHash = await hashAgentToken(plaintext);
    const tokensByHash = new Map<string, AgentTokenRow>([
      [
        storedHash,
        {
          id: "tok-1",
          user_id: "user-1",
          scopes: JSON.stringify(["message.read", "message.send"]),
          expires_at: null,
          revoked_at: null,
        },
      ],
    ]);
    const ctxWithToken = makeCtx(dbStub({ tokensByHash }), verify);
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    const principal = await authenticate(ctxWithToken, request);
    expect(principal.userId).toBe("user-1");
    expect(principal.permissions.has("message.send")).toBe(true);
  });

  it("ignores expired agent_tokens", async () => {
    const principal: Principal = {
      userId: "user-1",
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    };
    const storedHash = await hashAgentToken("any");
    const tokensByHash = new Map<string, AgentTokenRow>([
      [
        storedHash,
        {
          id: "expired",
          user_id: "user-1",
          scopes: JSON.stringify(["message.read"]),
          expires_at: Date.now() - 1000,
          revoked_at: null,
        },
      ],
    ]);
    verify = vi.fn(async () => principal);
    ctx = makeCtx(dbStub({ tokensByHash }), verify);
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: "Bearer jwt-fallback" },
    });
    await expect(authenticate(ctx, request)).resolves.toEqual(principal);
  });

  it("rejects agent_tokens owned by a suspended account", async () => {
    const plaintext = "sk-mcp-very-secret-token";
    const storedHash = await hashAgentToken(plaintext);
    const tokensByHash = new Map<string, AgentTokenRow>([
      [
        storedHash,
        {
          id: "tok-1",
          user_id: "user-1",
          scopes: JSON.stringify(["message.read"]),
          expires_at: null,
          revoked_at: null,
        },
      ],
    ]);
    const ctxWithSuspended = makeCtx(
      dbStub({
        tokensByHash,
        user: { email: "owner@example.com", status: "suspended" },
      }),
      verify,
    );
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    await expect(authenticate(ctxWithSuspended, request)).rejects.toMatchObject(
      {
        code: "forbidden",
      },
    );
  });

  it("validates JWT via TokenService (end-to-end)", async () => {
    const tokens = new TokenService("a".repeat(32));
    const jwt = await tokens.createAccessToken({
      userId: "user-1",
      email: "owner@example.com",
      permissions: ["message.read"],
    });
    const verifyImpl = (input: string) => tokens.verifyAccessToken(input);
    const ctxWithJwt = {
      env: { DB: dbStub() },
      identity: { verifyAccessToken: vi.fn(verifyImpl) },
    } as never;
    const request = new Request("https://example.com/mcp", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const principal = await authenticate(ctxWithJwt, request);
    expect(principal.userId).toBe("user-1");
    expect(principal.email).toBe("owner@example.com");
    expect(principal.permissions.has("message.read")).toBe(true);
  });

  it("hashAgentToken matches hashRefreshToken so storage is uniform", async () => {
    expect(hashAgentToken).toBe(hashRefreshToken);
    expect(await hashAgentToken("abc")).toBe(await hashRefreshToken("abc"));
  });
});

describe("_parseBearerForTests", () => {
  it("accepts the standard 'Bearer <token>' shape", () => {
    expect(_parseBearerForTests("Bearer abc")).toBe("abc");
  });
  it("rejects null", () => {
    expect(_parseBearerForTests(null)).toBe(null);
  });
  it("rejects wrong scheme", () => {
    expect(_parseBearerForTests("Token abc")).toBe(null);
  });
});

describe("assertScope", () => {
  it("throws forbidden when a permission key is missing", () => {
    const principal: Principal = {
      userId: "user-1",
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    };
    try {
      assertScope(principal, ["message.send"]);
      throw new Error("assertScope should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(McpToolError);
      expect((error as McpToolError).code).toBe("forbidden");
      expect((error as McpToolError).details).toEqual({
        required: "message.send",
      });
    }
  });

  it("returns when every required key is present", () => {
    const principal: Principal = {
      userId: "user-1",
      email: "owner@example.com",
      permissions: new Set(["message.read", "message.send"]),
    };
    expect(() => assertScope(principal, ["message.send"])).not.toThrow();
  });
});
