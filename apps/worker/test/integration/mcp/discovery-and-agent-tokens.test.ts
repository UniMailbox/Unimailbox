import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InstallationStep,
  PERMISSION_KEYS,
  type Principal,
} from "@unimailbox/contracts";
import { TokenService } from "../../../src/modules/identity";
import { AgentTokenApplicationService } from "../../../src/modules/agent-tokens";
import { createHttpApp, type HttpAppContext } from "../../../src/http/router";
import { makeEnv } from "../env-fixture";

/**
 * PR #8 — integration tests for the discovery surface and the
 * `/api/v1/agent_tokens` REST endpoints.
 *
 * The discovery endpoints must be reachable without authentication
 * (clients cache them before authenticating) and must derive their
 * origin from `X-Forwarded-Host` first, falling back to `Host`, and
 * finally to the request URL. The agent token endpoints follow the
 * existing REST permission pattern (`user.manage`).
 */

const userId = "11111111-1111-4111-8111-111111111111";
const authTokens = new TokenService("x".repeat(32));

declare global {
  // eslint-disable-next-line no-var
  var MCP_ENABLED: boolean | undefined;
}

function ctx(agentTokens: AgentTokenApplicationService): HttpAppContext {
  return {
    installation: {
      getStatus: async () => ({
        installationVersion: 2,
        stateVersion: 1,
        currentStep: InstallationStep.COMPLETE,
        completedSteps: [],
      }),
    },
    health: {
      check: async () => ({
        status: "ok" as const,
        checks: {
          database: "ok",
          kv: "ok",
          r2: "ok",
          queue: "ok",
          assets: "ok",
          scheduled: "ok",
        },
        storage: {
          backend: "kv" as const,
          reason: "R2 binding absent in test pool",
        },
        release: {
          applicationVersion: "0.1.0",
          upstreamVersion: "0.1.0",
          workerVersionId: "integration",
          workerVersionTag: "test",
          deployedAt: "2026-08-02T00:00:00.000Z",
        },
        operationalAlerts: [],
      }),
    },
    settings: {} as HttpAppContext["settings"],
    infrastructure: {} as HttpAppContext["infrastructure"],
    auth: {
      verifyAccessToken: async (token: string) =>
        authTokens.verifyAccessToken(token),
    },
    identity: {} as HttpAppContext["identity"],
    mailboxes: {} as HttpAppContext["mailboxes"],
    messages: {} as HttpAppContext["messages"],
    attachments: {} as HttpAppContext["attachments"],
    drafts: {} as HttpAppContext["drafts"],
    webhooks: {} as HttpAppContext["webhooks"],
    admin: {} as HttpAppContext["admin"],
    agentTokens,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as HttpAppContext;
}

async function bootstrap(agentTokens: AgentTokenApplicationService) {
  const app = createHttpApp(async () => ctx(agentTokens));
  return app;
}

async function insertUser() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, password_hash, password_algorithm, password_salt, password_iterations, status, display_name, created_at, updated_at)
     VALUES (?, ?, 'x', 'pbkdf2-sha256', 'x', 1, 'active', 'Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(userId, "owner@example.com")
    .run();
}

async function jwtFor(principal: Principal) {
  return authTokens.createAccessToken({
    userId: principal.userId,
    email: principal.email,
    permissions: [...principal.permissions],
  });
}

function service() {
  return new AgentTokenApplicationService(makeEnv());
}

describe("MCP discovery endpoints", () => {
  beforeAll(async () => {
    globalThis.MCP_ENABLED = true;
    await applyD1Migrations(
      env.DB,
      (env as unknown as { TEST_MIGRATIONS?: unknown[] })
        .TEST_MIGRATIONS as never,
    );
  });

  beforeEach(async () => {
    await insertUser();
  });

  it("exposes PRM metadata that points at /mcp and lists scopes", async () => {
    const app = await bootstrap(service());
    const response = await app.request(
      "/.well-known/oauth-protected-resource",
      { headers: { host: "unimailbox.example" } },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      resource: "https://unimailbox.example/mcp",
      authorization_servers: ["https://unimailbox.example/oauth"],
      bearer_methods_supported: ["header"],
    });
    expect(body.scopes_supported).toEqual([...PERMISSION_KEYS]);
  });

  it("honors X-Forwarded-Host before Host", async () => {
    const app = await bootstrap(service());
    const response = await app.request(
      "/.well-known/mcp.json",
      {
        headers: {
          "x-forwarded-host": "edge.unimailbox.example",
          host: "internal-worker",
          "x-forwarded-proto": "https",
        },
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.endpoint).toBe("https://edge.unimailbox.example/mcp");
    expect(body.transport).toBe("streamable-http");
    expect(body.auth_methods).toEqual(["bearer"]);
  });

  it("returns the AS metadata with PKCE / S256 support", async () => {
    const app = await bootstrap(service());
    const response = await app.request(
      "/.well-known/oauth-authorization-server",
      { headers: { host: "unimailbox.example" } },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "experimental",
      issuer: "https://unimailbox.example",
      authorization_endpoint: "https://unimailbox.example/oauth/authorize",
      token_endpoint: "https://unimailbox.example/oauth/token",
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("agent token REST surface", () => {
  beforeAll(async () => {
    globalThis.MCP_ENABLED = true;
    await applyD1Migrations(
      env.DB,
      (env as unknown as { TEST_MIGRATIONS?: unknown[] })
        .TEST_MIGRATIONS as never,
    );
  });

  beforeEach(async () => {
    await insertUser();
  });

  it("requires authentication on every endpoint", async () => {
    const app = await bootstrap(service());
    const list = await app.request("/api/v1/agent_tokens", {}, makeEnv());
    expect(list.status).toBe(401);
    const create = await app.request(
      "/api/v1/agent_tokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "x",
          scopes: ["message.read"],
        }),
      },
      makeEnv(),
    );
    expect(create.status).toBe(401);
  });

  it("creates, lists, and revokes tokens for the calling user", async () => {
    const agentTokens = service();
    const app = await bootstrap(agentTokens);
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["user.manage", "message.read"]),
    });

    const create = await app.request(
      "/api/v1/agent_tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          name: "Cursor",
          scopes: ["message.read", "message.send"],
        }),
      },
      makeEnv(),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      data: {
        id: string;
        name: string;
        scopes: string[];
        plaintext_token: string;
        token: string;
        revoked_at: number | null;
      };
    };
    expect(created.data.plaintext_token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(created.data.token).toBe(created.data.plaintext_token);
    expect(created.data.scopes).toEqual(["message.read", "message.send"]);

    const list = await app.request(
      "/api/v1/agent_tokens",
      { headers: { authorization: `Bearer ${jwt}` } },
      makeEnv(),
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      data: Array<{ id: string; name: string }>;
    };
    expect(listed.data.map((row) => row.id)).toContain(created.data.id);

    const revoke = await app.request(
      `/api/v1/agent_tokens/${created.data.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${jwt}` },
      },
      makeEnv(),
    );
    expect(revoke.status).toBe(204);

    const afterList = await app.request(
      "/api/v1/agent_tokens",
      { headers: { authorization: `Bearer ${jwt}` } },
      makeEnv(),
    );
    const afterBody = (await afterList.json()) as {
      data: Array<{ id: string; revoked_at: number | null }>;
    };
    const target = afterBody.data.find((row) => row.id === created.data.id);
    expect(target?.revoked_at).toBeTypeOf("number");
  });

  it("returns 403 when the caller is missing user.manage", async () => {
    const agentTokens = service();
    const app = await bootstrap(agentTokens);
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/api/v1/agent_tokens",
      { headers: { authorization: `Bearer ${jwt}` } },
      makeEnv(),
    );
    expect(response.status).toBe(403);
  });

  it("rejects unknown scopes at the schema boundary", async () => {
    const agentTokens = service();
    const app = await bootstrap(agentTokens);
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["user.manage"]),
    });
    const response = await app.request(
      "/api/v1/agent_tokens",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          name: "Bad",
          scopes: ["message.read", "definitely.not.a.scope"],
        }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });
});
