import {
  DomainError,
  InstallationStep,
  LoginSchema,
  MailboxCreateSchema,
  RegisterSchema,
  SendMessageSchema,
  type Principal,
} from "@unimailbox/contracts";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { AdminApplicationService } from "../modules/administration";
import type { InstallationService } from "../modules/installation";
import type { IdentityApplicationService } from "../modules/identity/application";
import type { MailboxApplicationService } from "../modules/mailboxes";
import type { HealthResult } from "../modules/maintenance";
import type { MessageApplicationService } from "../modules/messages";
import type { AttachmentApplicationService } from "../modules/attachments";
import type { DraftApplicationService } from "../modules/messages/drafts";
import type { WebhookApplicationService } from "../modules/provider-sync/webhook";
import type { Env } from "../platform/config";
import type { Logger } from "../platform/logger";
import { errorResponse } from "./errors";
import type { HttpAppBindings } from "./bindings";
import type { CloudflareSettingsService } from "../modules/administration/cloudflare-settings";
import type { InfrastructureSettingsService } from "../modules/administration/infrastructure-settings";
import { captureWorkerHttpError } from "../platform/sentry";

export interface HttpAppContext {
  installation: Pick<InstallationService, "getStatus">;
  health: { check(): Promise<HealthResult> };
  settings: CloudflareSettingsService;
  infrastructure: InfrastructureSettingsService;
  auth: {
    verifyAccessToken(token: string): Promise<Principal>;
  };
  identity: IdentityApplicationService;
  mailboxes: MailboxApplicationService;
  messages: MessageApplicationService;
  attachments: AttachmentApplicationService;
  drafts: DraftApplicationService;
  webhooks: WebhookApplicationService;
  admin: AdminApplicationService;
  logger: Logger;
}

export type HttpContextFactory = (
  env: Env,
  executionContext: ExecutionContext | undefined,
) => Promise<HttpAppContext>;

function success<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

function isBootstrapSafePath(path: string): boolean {
  return (
    path === "/health" || path === "/setup" || path.startsWith("/api/v1/setup/")
  );
}

function parseBearer(header: string | undefined): string | null {
  return header?.match(/^Bearer\s+(.+)$/iu)?.[1] ?? null;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const entry of header.split(";")) {
    const [key, ...parts] = entry.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return null;
}

function refreshCookie(token: string, expiresAt: string): string {
  const maxAge = Math.max(
    0,
    Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000),
  );
  return `unimailbox_refresh=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=${maxAge}`;
}

export function createHttpApp(createContext: HttpContextFactory) {
  const app = new Hono<HttpAppBindings>();

  // Middleware order is intentional and load-bearing:
  //   secureHeaders → requestId → CORS/OPTIONS short-circuit → appContext →
  //   bootstrap gate → per-resource auth/idempotency.
  // Reordering breaks the bootstrap carve-out (/health, /setup, /api/v1/setup/*)
  // and the 503 contract enforced by `BOOTSTRAP_INCOMPLETE`.
  app.use("*", secureHeaders());
  app.use("*", async (context, next) => {
    const requestId = context.req.header("cf-ray") ?? crypto.randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    await next();
  });
  app.use("*", async (context, next) => {
    const origin = context.req.header("origin");
    const requestOrigin = new URL(context.req.url).origin;
    if (context.req.method === "OPTIONS") {
      if (origin === requestOrigin) {
        context.header("access-control-allow-origin", origin);
        context.header("vary", "Origin");
      }
      context.header(
        "access-control-allow-headers",
        "authorization, content-type, idempotency-key, if-match, x-setup-csrf",
      );
      context.header(
        "access-control-allow-methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      return context.body(null, 204);
    }
    await next();
    if (origin === requestOrigin) {
      context.res.headers.set("access-control-allow-origin", origin);
      context.res.headers.append("vary", "Origin");
    }
  });
  app.use("*", async (context, next) => {
    context.set("appContext", await createContext(context.env, undefined));
    await next();
  });
  app.use("*", async (context, next) => {
    if (!isBootstrapSafePath(context.req.path)) {
      const status = await context.get("appContext").installation.getStatus();
      if (status.currentStep !== InstallationStep.COMPLETE) {
        throw new DomainError(
          "BOOTSTRAP_INCOMPLETE",
          "The deployment bootstrap has not completed",
          503,
        );
      }
    }
    await next();
  });

  app.get("/health", async (context) =>
    success(await context.get("appContext").health.check()),
  );

  app.get("/setup", (context) => context.redirect("/login", 307));

  app.post("/api/v1/webhooks/:providerKey/:connectionId", async (context) =>
    success(
      await context
        .get("appContext")
        .webhooks.handle(
          context.req.param("providerKey"),
          context.req.param("connectionId"),
          context.req.raw,
        ),
    ),
  );

  app.post("/api/v1/auth/register", async (context) =>
    success(
      await context
        .get("appContext")
        .identity.register(
          RegisterSchema.parse(await context.req.json()),
          context.req.raw,
        ),
      { status: 201 },
    ),
  );

  app.post("/api/v1/auth/login", async (context) => {
    const tokens = await context
      .get("appContext")
      .identity.login(
        LoginSchema.parse(await context.req.json()),
        context.req.raw,
      );
    const response = success({
      accessToken: tokens.accessToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    });
    response.headers.append(
      "set-cookie",
      refreshCookie(tokens.refreshToken, tokens.refreshTokenExpiresAt),
    );
    return response;
  });

  app.post("/api/v1/auth/refresh", async (context) => {
    const refreshToken = readCookie(context.req.raw, "unimailbox_refresh");
    if (!refreshToken) {
      throw new DomainError(
        "REFRESH_TOKEN_REQUIRED",
        "A refresh token is required",
        401,
      );
    }
    const tokens = await context
      .get("appContext")
      .identity.refresh(refreshToken, context.req.raw);
    const response = success({
      accessToken: tokens.accessToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    });
    response.headers.append(
      "set-cookie",
      refreshCookie(tokens.refreshToken, tokens.refreshTokenExpiresAt),
    );
    return response;
  });

  app.post("/api/v1/auth/logout", async (context) => {
    const refreshToken = readCookie(context.req.raw, "unimailbox_refresh");
    if (refreshToken) {
      await context.get("appContext").identity.logout(refreshToken);
    }
    const response = success({ revoked: true });
    response.headers.append(
      "set-cookie",
      "unimailbox_refresh=; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age=0",
    );
    return response;
  });

  // The web client needs an authoritative answer to "who am I, and what may I
  // do?" before it renders a protected route. Everything required already sits
  // inside the verified access token, so this handler never touches D1 and is
  // cheap enough to run on every navigation.
  app.use("/api/v1/auth/session", requireAuth());
  app.get("/api/v1/auth/session", (context) => {
    const principal = context.get("principal");
    return success({
      userId: principal.userId,
      email: principal.email,
      permissions: [...principal.permissions].sort(),
    });
  });


  app.use("/api/v1/mailboxes", requireAuth());
  app.use("/api/v1/mailboxes/*", requireAuth());

  app.get("/api/v1/mailboxes", async (context) =>
    success(
      await context.get("appContext").mailboxes.list(context.get("principal")),
    ),
  );
  app.post("/api/v1/mailboxes", async (context) =>
    success(
      await context
        .get("appContext")
        .mailboxes.create(
          context.get("principal"),
          MailboxCreateSchema.parse(await context.req.json()),
        ),
      { status: 201 },
    ),
  );
  app.get("/api/v1/mailboxes/:id", async (context) =>
    success(
      await context
        .get("appContext")
        .mailboxes.get(context.get("principal"), context.req.param("id")),
    ),
  );
  app.patch("/api/v1/mailboxes/:id", async (context) => {
    const input = await context.req.json<{ displayName?: unknown }>();
    if (
      typeof input.displayName !== "string" ||
      input.displayName.length > 120
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "displayName must be a string up to 120 characters",
      );
    }
    return success(
      await context
        .get("appContext")
        .mailboxes.rename(
          context.get("principal"),
          context.req.param("id"),
          input.displayName,
        ),
    );
  });
  app.delete("/api/v1/mailboxes/:id", async (context) => {
    await context
      .get("appContext")
      .mailboxes.remove(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });
  app.use("/api/v1/messages", requireAuth());
  app.use("/api/v1/messages/*", requireAuth());
  app.post("/api/v1/messages/send", async (context) =>
    success(
      await context
        .get("appContext")
        .messages.send(
          context.get("principal"),
          SendMessageSchema.parse(await context.req.json()),
          context.req.header("idempotency-key") ?? "",
        ),
      { status: 201 },
    ),
  );
  app.get("/api/v1/messages/:id", async (context) =>
    success(
      await context
        .get("appContext")
        .messages.get(context.get("principal"), context.req.param("id")),
    ),
  );
  app.patch("/api/v1/messages/:id/read", async (context) => {
    const input = await context.req.json<{ isRead?: unknown }>();
    if (typeof input.isRead !== "boolean") {
      throw new DomainError("VALIDATION_FAILED", "isRead must be a boolean");
    }
    await context
      .get("appContext")
      .messages.setRead(
        context.get("principal"),
        context.req.param("id"),
        input.isRead,
      );
    return success({ updated: true });
  });
  app.patch("/api/v1/messages/:id/star", async (context) => {
    const input = await context.req.json<{ isStarred?: unknown }>();
    if (typeof input.isStarred !== "boolean") {
      throw new DomainError("VALIDATION_FAILED", "isStarred must be a boolean");
    }
    await context
      .get("appContext")
      .messages.setStarred(
        context.get("principal"),
        context.req.param("id"),
        input.isStarred,
      );
    return success({ updated: true });
  });
  app.patch("/api/v1/messages/:id/folder", async (context) => {
    const input = z
      .object({
        mailboxId: z.string().uuid(),
        folder: z.enum(["inbox", "archive", "trash"]),
      })
      .parse(await context.req.json());
    await context
      .get("appContext")
      .messages.move(
        context.get("principal"),
        context.req.param("id"),
        input.mailboxId,
        input.folder,
      );
    return success({ updated: true, folder: input.folder });
  });
  app.delete("/api/v1/messages/:id", async (context) => {
    await context
      .get("appContext")
      .messages.remove(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });

  app.get("/api/v1/mailboxes/:id/messages", async (context) => {
    const folder = context.req.query("folder") ?? "inbox";
    if (!["inbox", "sent", "drafts", "archive", "trash"].includes(folder)) {
      throw new DomainError("VALIDATION_FAILED", "Invalid mailbox folder");
    }
    const rawLimit = Number.parseInt(context.req.query("limit") ?? "50", 10);
    const limit = Math.min(
      100,
      Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50),
    );
    return success(
      await context
        .get("appContext")
        .messages.list(context.get("principal"), context.req.param("id"), {
          folder: folder as "inbox" | "sent" | "drafts" | "archive" | "trash",
          ...(context.req.query("cursor")
            ? { cursor: context.req.query("cursor") }
            : {}),
          limit,
          ...(context.req.query("starred") === "true" ? { starred: true } : {}),
        }),
    );
  });

  // ===== /api/v1/admin ===== (M1 surfaces — only what's referenced by
  // blueprint §5.2..§5.6 verification gates. The rest of the admin module
  // (users, roles, webhooks, analytics, providers, cloudflare OAuth,
  // signatures, maintenance, integrations, MCP) keeps the schema/methods
  // compiled but is unrouted. See /docs/architecture/mvp-blueprint.md.)

  app.use("/api/v1/admin", requireAuth());
  app.use("/api/v1/admin/*", requireAuth());

  // Domains — list / read / create (M1 setup) / update status / delete.
  app.get("/api/v1/admin/domains", async (context) =>
    success(
      await context.get("appContext").admin.listDomains(context.get("principal")),
    ),
  );
  app.post("/api/v1/admin/domains", async (context) => {
    const input = z
      .object({
        name: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .settings.createDomain(context.get("principal"), input),
      { status: 201 },
    );
  });
  app.get("/api/v1/admin/domains/:id", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listDomains(context.get("principal"))
        .then((items) => {
          const item = items.find((row) => row.id === context.req.param("id"));
          if (!item) {
            throw new DomainError("DOMAIN_NOT_FOUND", "Domain not found", 404);
          }
          return item;
        }),
    ),
  );

  // System settings (M1 §5.6).
  app.get("/api/v1/admin/system-settings", async (context) =>
    success(
      await context.get("appContext").admin.getSettings(context.get("principal")),
    ),
  );
  app.patch("/api/v1/admin/system-settings", async (context) =>
    success(
      await context.get("appContext").admin.updateSettings(
        context.get("principal"),
        z
          .object({
            site_title: z.string().trim().min(1).max(120).optional(),
            registration_enabled: z.coerce
              .number()
              .int()
              .min(0)
              .max(1)
              .optional(),
            invite_required: z.coerce.number().int().min(0).max(1).optional(),
            inbound_enabled: z.coerce.number().int().min(0).max(1).optional(),
            outbound_enabled: z.coerce.number().int().min(0).max(1).optional(),
            unknown_recipient_policy: z.enum(["reject", "store"]).optional(),
          })
          .strict()
          .parse(await context.req.json()),
      ),
    ),
  );

  // Audit events (M1 §5.6). The comprehensive audit-events page lives in
  // M5; this minimal list endpoint is enough for the verification gate.
  app.get("/api/v1/admin/audit-events", async (context) =>
    success(
      await context.get("appContext").admin.listAuditEvents(
        context.get("principal"),
        {
          limit: Number.parseInt(context.req.query("limit") ?? "100", 10),
          query: context.req.query("q"),
        },
      ),
    ),
  );

  app.notFound(async (context) => {
    if (context.req.path.startsWith("/api/")) {
      throw new DomainError("NOT_FOUND", "Route not found", 404);
    }
    if (context.env.ASSETS) {
      return context.env.ASSETS.fetch(context.req.raw);
    }
    throw new DomainError("NOT_FOUND", "Route not found", 404);
  });

  app.onError((error, context) => {
    const requestId = context.get("requestId") ?? crypto.randomUUID();
    context.get("appContext")?.logger.error("http.request.failed", {
      requestId,
      path: context.req.path,
      method: context.req.method,
      error: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
    });
    captureWorkerHttpError(error, {
      requestId,
      path: context.req.path,
      method: context.req.method,
    });
    // `errorResponse` returns a fresh Response; `context.header()` here
    // mutates a discarded response builder, so the header must be set on
    // the returned Response for the wire (issue #19 contract).
    const response = errorResponse(error, requestId);
    response.headers.set("x-request-id", requestId);
    return response;
  });

  return app;
}

export function requireAuth(): MiddlewareHandler<HttpAppBindings> {
  return async (context, next) => {
    const token = parseBearer(context.req.header("authorization"));
    if (!token) {
      throw new DomainError("AUTH_REQUIRED", "Authentication is required", 401);
    }
    context.set(
      "principal",
      await context.get("appContext").auth.verifyAccessToken(token),
    );
    await next();
  };
}


