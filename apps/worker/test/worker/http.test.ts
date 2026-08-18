import { describe, expect, it, vi } from "vitest";
import { DomainError, InstallationStep } from "@unimailbox/contracts";
import { createHttpApp, type HttpAppContext } from "../../src/http/router";
import type { Env } from "../../src/platform/config";

function context(overrides: Partial<HttpAppContext> = {}): HttpAppContext {
  return {
    installation: {
      getStatus: async () => ({
        installationVersion: 2,
        stateVersion: 0,
        currentStep: InstallationStep.ADMIN_BOOTSTRAP,
        completedSteps: [],
      }),
    },
    health: {
      check: async () => ({
        status: "ok",
        checks: {
          database: "ok",
          kv: "ok",
          r2: "ok",
          queue: "ok",
          assets: "ok",
          scheduled: "ok",
        },
        storage: {
          backend: "r2",
          reason: "ATTACHMENTS binding is present in the Worker env",
        },
        release: {
          applicationVersion: "0.1.0",
          upstreamVersion: "0.1.0",
          workerVersionId: "worker-version",
          workerVersionTag: "test",
          deployedAt: "2026-08-02T00:00:00.000Z",
        },
        operationalAlerts: [],
      }),
    },
    settings: {} as HttpAppContext["settings"],
    infrastructure: {} as HttpAppContext["infrastructure"],
    auth: {
      verifyAccessToken: vi.fn(),
    },
    identity: {} as HttpAppContext["identity"],
    mailboxes: {} as HttpAppContext["mailboxes"],
    messages: {} as HttpAppContext["messages"],
    attachments: {} as HttpAppContext["attachments"],
    drafts: {} as HttpAppContext["drafts"],
    webhooks: {} as HttpAppContext["webhooks"],
    admin: {} as HttpAppContext["admin"],
    agentTokens: {} as HttpAppContext["agentTokens"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

const env = {} as Env;

function idempotencyDatabase() {
  const records = new Map<
    string,
    { request_hash: string; response_json: string }
  >();
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (!sql.includes("SELECT request_hash")) return null;
              return (
                records.get(`${values[0]}:${values[1]}:${values[2]}`) ?? null
              );
            },
            async run() {
              if (sql.includes("INSERT INTO idempotency_records")) {
                records.set(`${values[1]}:${values[2]}:${values[3]}`, {
                  request_hash: String(values[4]),
                  response_json: String(values[6]),
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

describe("Worker HTTP boundary", () => {
  it("exposes health but removes the public installation claim", async () => {
    const app = createHttpApp(async () => context());

    const health = await app.request("/health", {}, env);
    const claim = await app.request(
      "/api/v1/setup/claim",
      { method: "POST" },
      env,
    );

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      data: { status: "ok" },
    });
    expect(claim.status).toBe(404);
  });

  it("returns a deployment error until bootstrap completes", async () => {
    const app = createHttpApp(async () => context());
    const response = await app.request("/inbox/mailbox-1", {}, env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BOOTSTRAP_INCOMPLETE" },
    });
  });

  it("redirects the legacy setup page to login after bootstrap", async () => {
    const app = createHttpApp(async () =>
      context({
        installation: {
          getStatus: async () => ({
            installationVersion: 2,
            stateVersion: 1,
            currentStep: InstallationStep.COMPLETE,
            completedSteps: ["admin_bootstrap"],
          }),
        },
      }),
    );
    const response = await app.request("/setup", {}, env);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("returns structured errors with request IDs", async () => {
    const app = createHttpApp(async () =>
      context({
        health: {
          check: async () => {
            throw new Error("database detail must stay private");
          },
        },
      }),
    );
    const response = await app.request("/health", {}, env);
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(response.status).toBe(500);
    expect(body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
    expect(body.error.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    expect(body.error.message).not.toContain("database detail");
  });

  it("uses a strict same-origin CORS policy", async () => {
    const app = createHttpApp(async () => context());
    const denied = await app.request(
      "https://mail.example/health",
      { headers: { origin: "https://evil.example" } },
      env,
    );
    const allowed = await app.request(
      "https://mail.example/health",
      { headers: { origin: "https://mail.example" } },
      env,
    );

    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://mail.example",
    );
  });

  it("replays administrator mutations by idempotency key", async () => {
    const createDomain = vi.fn(
      async (_principal: unknown, input: { name: string }) => ({
        id: "11111111-1111-4111-8111-111111111111",
        name: input.name,
        expectedRoute: `*@${input.name} -> unimailbox Worker`,
        routingConfiguration: {
          status: "manual_setup_required" as const,
          dashboardUrl:
            "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Frouting",
        },
      }),
    );
    const completeContext = context({
      installation: {
        getStatus: async () => ({
          installationVersion: 2,
          stateVersion: 8,
          currentStep: InstallationStep.COMPLETE,
          completedSteps: [],
        }),
      },
      auth: {
        verifyAccessToken: async () => ({
          userId: "user-1",
          email: "admin@example.com",
          permissions: new Set(["domain.manage"]),
        }),
      },
      settings: { createDomain } as unknown as HttpAppContext["settings"],
    });
    const app = createHttpApp(async () => completeContext);
    const testEnv = {
      DB: idempotencyDatabase(),
    } as Env;
    const request = () =>
      app.request(
        "https://mail.example/api/v1/admin/domains",
        {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            "idempotency-key": "admin-command-1",
          },
          body: JSON.stringify({ name: "mail.example.com" }),
        },
        testEnv,
      );

    const first = await request();
    const replay = await request();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-idempotent-replay")).toBe("1");
    expect(createDomain).toHaveBeenCalledTimes(1);
    await expect(replay.json()).resolves.toEqual({
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "mail.example.com",
        expectedRoute: "*@mail.example.com -> unimailbox Worker",
        routingConfiguration: {
          status: "manual_setup_required",
          dashboardUrl:
            "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Frouting",
        },
      },
    });
  });

  describe("GET /api/v1/auth/session", () => {
    function completed(overrides: Partial<HttpAppContext> = {}) {
      return context({
        installation: {
          getStatus: async () => ({
            installationVersion: 2,
            stateVersion: 8,
            currentStep: InstallationStep.COMPLETE,
            completedSteps: [],
          }),
        },
        ...overrides,
      });
    }

    it("returns the identity and permissions carried by the access token", async () => {
      const verifyAccessToken = vi.fn(async () => ({
        userId: "user-1",
        email: "admin@example.com",
        // Deliberately unsorted so the stable ordering of the response is
        // covered: the web client memoises on this payload.
        permissions: new Set(["user.read", "analytics.read", "domain.read"]),
      }));
      const app = createHttpApp(async () =>
        completed({
          auth: { verifyAccessToken } as unknown as HttpAppContext["auth"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/auth/session",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: {
          userId: "user-1",
          email: "admin@example.com",
          permissions: ["analytics.read", "domain.read", "user.read"],
        },
      });
      expect(verifyAccessToken).toHaveBeenCalledWith("access-token");
    });

    it("rejects an unauthenticated probe with AUTH_REQUIRED", async () => {
      // This is the signal the web route guard turns into a /login redirect,
      // so the status and code are part of the contract.
      const app = createHttpApp(async () => completed());

      const response = await app.request(
        "https://mail.example/api/v1/auth/session",
        {},
        env,
      );

      expect(response.status).toBe(401);
      const body = (await response.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("AUTH_REQUIRED");
    });

    it("rejects a token the auth service refuses", async () => {
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => {
              throw new DomainError(
                "AUTH_TOKEN_INVALID",
                "The access token is not valid",
                401,
              );
            },
          } as unknown as HttpAppContext["auth"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/auth/session",
        { headers: { authorization: "Bearer stale" } },
        env,
      );

      expect(response.status).toBe(401);
    });

    it("reports an empty permission set rather than failing", async () => {
      // A member with no console permissions must still get a 200: the guard
      // distinguishes "signed in but unauthorised" from "not signed in".
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => ({
              userId: "user-2",
              email: "member@example.com",
              permissions: new Set([]),
            }),
          } as unknown as HttpAppContext["auth"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/auth/session",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        data: {
          userId: "user-2",
          email: "member@example.com",
          permissions: [],
        },
      });
    });
  });

  describe("administrator message HTTP boundary", () => {
    function completed(overrides: Partial<HttpAppContext> = {}) {
      return context({
        installation: {
          getStatus: async () => ({
            installationVersion: 2,
            stateVersion: 8,
            currentStep: InstallationStep.COMPLETE,
            completedSteps: [],
          }),
        },
        ...overrides,
      });
    }

    it("requires authentication before listing global messages", async () => {
      const listMessages = vi.fn();
      const app = createHttpApp(async () =>
        completed({
          admin: { listMessages } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/messages",
        {},
        env,
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "AUTH_REQUIRED" },
      });
      expect(listMessages).not.toHaveBeenCalled();
    });

    it("passes the verified principal and bounded query to the service", async () => {
      const principal = {
        userId: "user-1",
        email: "admin@example.com",
        permissions: new Set(["message.read_all"]),
      };
      const listMessages = vi.fn(async () => ({
        items: [],
        nextCursor: null,
      }));
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => principal,
          } as unknown as HttpAppContext["auth"],
          admin: { listMessages } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/messages?limit=1000",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(200);
      expect(listMessages).toHaveBeenCalledWith(principal, { limit: 100 });
    });

    it("rejects an invalid detail ID before reading message content", async () => {
      const getMessage = vi.fn();
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => ({
              userId: "user-1",
              email: "admin@example.com",
              permissions: new Set(["message.read_all"]),
            }),
          } as unknown as HttpAppContext["auth"],
          admin: { getMessage } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/messages/not-a-uuid",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
      expect(getMessage).not.toHaveBeenCalled();
    });

    it("passes normalized attachment search to the global catalog", async () => {
      const principal = {
        userId: "user-1",
        email: "admin@example.com",
        permissions: new Set(["message.read_all"]),
      };
      const listAttachments = vi.fn(async () => ({
        items: [],
        nextCursor: null,
      }));
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => principal,
          } as unknown as HttpAppContext["auth"],
          admin: { listAttachments } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/attachments?limit=1000&q=%20report.pdf%20",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(200);
      expect(listAttachments).toHaveBeenCalledWith(principal, {
        limit: 100,
        q: "report.pdf",
      });
    });

    it("rejects an invalid global attachment ID before downloading bytes", async () => {
      const downloadAttachment = vi.fn();
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => ({
              userId: "user-1",
              email: "admin@example.com",
              permissions: new Set(["message.read_all"]),
            }),
          } as unknown as HttpAppContext["auth"],
          admin: { downloadAttachment } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/attachments/not-a-uuid/download",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(400);
      expect(downloadAttachment).not.toHaveBeenCalled();
    });
  });
});
