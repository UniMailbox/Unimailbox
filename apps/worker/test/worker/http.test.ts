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
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

const env = {} as Env;

describe("Worker HTTP boundary (M1 surface)", () => {
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

    const response = await app.request(
      "https://mail.example/api/v1/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "admin@example.com",
          password: "correct-horse-battery-staple",
        }),
      },
      env,
    );

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

    const response = await app.request(
      "https://mail.example/api/v1/auth/login",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-ray": "test-request-id",
        },
        body: JSON.stringify({ email: "bad", password: "x" }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("test-request-id");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("uses a strict same-origin CORS policy", async () => {
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

    const response = await app.request(
      "https://mail.example/api/v1/auth/login",
      {
        method: "OPTIONS",
        headers: { origin: "https://attacker.example" },
      },
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("forwards the idempotency header to the messages service", async () => {
    // The M1 router no longer wires `requireAdminIdempotency`
    // (issue #19, blueprint §2). Idempotency is now an application-level
    // concern inside MessageApplicationService. The router keeps the
    // header available via context.req.header, and the test below pins
    // that contract: the header survives to the dispatched call.
    const send = vi.fn(async () => ({
      messageId: "11111111-1111-4111-8111-111111111111",
      providerMessageId: null,
      status: "sent" as const,
    }));
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
        auth: {
          verifyAccessToken: async () => ({
            userId: "user-1",
            email: "admin@example.com",
            permissions: new Set(["message.send"]),
          }),
        },
        messages: { send } as unknown as HttpAppContext["messages"],
      }),
    );

    const response = await app.request(
      "https://mail.example/api/v1/messages/send",
      {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
          "idempotency-key": "send-1",
        },
        body: JSON.stringify({
          mailboxId: "11111111-1111-4111-8111-111111111111",
          to: ["recipient@example.com"],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "send-1",
    );
  });

  describe("GET /api/v1/auth/session", () => {
    function completed(overrides: Partial<HttpAppContext> = {}) {
      return context({
        installation: {
          getStatus: async () => ({
            installationVersion: 2,
            stateVersion: 1,
            currentStep: InstallationStep.COMPLETE,
            completedSteps: ["admin_bootstrap"],
          }),
        },
        ...overrides,
      });
    }

    it("returns the identity and permissions carried by the access token", async () => {
      const verifyAccessToken = vi.fn(async () => ({
        userId: "user-1",
        email: "admin@example.com",
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
      const body = (await response.json()) as {
        data: {
          userId: string;
          email: string;
          permissions: string[];
        };
      };
      expect(body.data.userId).toBe("user-1");
      expect(body.data.permissions).toEqual([
        "analytics.read",
        "domain.read",
        "user.read",
      ]);
    });

    it("rejects an unauthenticated probe with AUTH_REQUIRED", async () => {
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
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => ({
              userId: "user-2",
              email: "member@example.com",
              permissions: new Set(),
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
      const body = (await response.json()) as {
        data: {
          userId: string;
          email: string;
          permissions: string[];
        };
      };
      expect(body.data).toEqual({
        userId: "user-2",
        email: "member@example.com",
        permissions: [],
      });
    });
  });

  describe("M1 admin surface", () => {
    function completed(overrides: Partial<HttpAppContext> = {}) {
      return context({
        installation: {
          getStatus: async () => ({
            installationVersion: 2,
            stateVersion: 1,
            currentStep: InstallationStep.COMPLETE,
            completedSteps: ["admin_bootstrap"],
          }),
        },
        ...overrides,
      });
    }

    it("requires authentication before listing domains", async () => {
      const listDomains = vi.fn();
      const app = createHttpApp(async () =>
        completed({
          admin: { listDomains } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/domains",
        {},
        env,
      );

      expect(response.status).toBe(401);
      expect(listDomains).not.toHaveBeenCalled();
    });

    it("returns the system settings when authenticated", async () => {
      const getSettings = vi.fn(async () => ({
        site_title: "Cloud Mail",
        registration_enabled: 0,
        invite_required: 1,
        inbound_enabled: 1,
        outbound_enabled: 1,
        unknown_recipient_policy: "reject",
        max_mailboxes_per_user: 10,
        max_attachments_per_message: 10,
        max_attachment_bytes: 67108864,
        sender_blocklist_json: "[]",
        subject_blocklist_json: "[]",
        content_blocklist_json: "[]",
      }));
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => ({
              userId: "user-1",
              email: "admin@example.com",
              permissions: new Set(["settings.read"]),
            }),
          } as unknown as HttpAppContext["auth"],
          admin: { getSettings } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/system-settings",
        { headers: { authorization: "Bearer access-token" } },
        env,
      );

      expect(response.status).toBe(200);
      expect(getSettings).toHaveBeenCalled();
    });

    it("rejects PATCH on system settings without the proper permission", async () => {
      // The router itself does not gate PATCH by permission; the
      // assertion lives inside admin.updateSettings. Mirror it in the
      // mock so the test exercises the boundary without setting up a
      // full D1 / settings schema.
      const updateSettings = vi.fn(
        (
          principal: { permissions: ReadonlySet<string> },
          _input: unknown,
        ) => {
          if (!principal.permissions.has("settings.manage")) {
            throw new DomainError(
              "PERMISSION_DENIED",
              "Permission settings.manage is required",
              403,
            );
          }
          return { ok: true };
        },
      );
      const app = createHttpApp(async () =>
        completed({
          auth: {
            verifyAccessToken: async () => ({
              userId: "user-1",
              email: "admin@example.com",
              permissions: new Set(["settings.read"]),
            }),
          } as unknown as HttpAppContext["auth"],
          admin: { updateSettings } as unknown as HttpAppContext["admin"],
        }),
      );

      const response = await app.request(
        "https://mail.example/api/v1/admin/system-settings",
        {
          method: "PATCH",
          headers: {
            authorization: "Bearer access-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ outbound_enabled: 0 }),
        },
        env,
      );

      expect(response.status).toBe(403);
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
  });
});
