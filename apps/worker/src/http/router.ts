import {
  AdminMessageListQuerySchema,
  AdminMessageParamsSchema,
  AdminAttachmentListQuerySchema,
  AdminAttachmentParamsSchema,
  DomainError,
  CreateAttachmentUploadSchema,
  DraftMessageSchema,
  DraftScheduleSchema,
  InstallationStep,
  LoginSchema,
  MailboxCreateSchema,
  MailboxMemberSchema,
  PERMISSION_KEYS,
  ProviderConnectionSchema,
  RegisterSchema,
  SendMessageSchema,
  type Principal,
} from "@unimailbox/contracts";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { AdminApplicationService } from "../modules/administration";
import type { AgentTokenApplicationService } from "../modules/agent-tokens";
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
import { requireAdminIdempotency } from "./admin-idempotency";
import type { HttpAppBindings } from "./bindings";
import type { CloudflareSettingsService } from "../modules/administration/cloudflare-settings";
import type { InfrastructureSettingsService } from "../modules/administration/infrastructure-settings";
import { captureWorkerHttpError } from "../platform/sentry";
import { handleMcpRequest } from "../entrypoints/mcp";

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
  agentTokens: AgentTokenApplicationService;
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
  if (path === "/health" || path === "/setup") return true;
  if (path.startsWith("/api/v1/setup/")) return true;
  // MCP discovery is part of the deployment's public contract;
  // clients cache it before authenticating and operators run it
  // before installation finishes. Without this carve-out the PRM
  // metadata would 503 until the bootstrap is complete.
  if (path.startsWith("/.well-known/")) return true;
  return false;
}

const AgentTokenCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.enum(PERMISSION_KEYS)).min(1).max(PERMISSION_KEYS.length),
  expires_at: z
    .union([z.string().min(1), z.number().int().positive()])
    .nullable()
    .optional(),
});

/**
 * Derive the deployment origin from request headers so the
 * `.well-known/*` documents remain portable behind the Cloudflare edge.
 *
 * `X-Forwarded-Host` wins when present — Cloudflare's CDN always sets
 * it to the host the client used to reach the worker, and `Host` only
 * reflects the Worker route binding. Local `wrangler dev` does not
 * inject `X-Forwarded-Host`, so we fall back to `Host`; the request
 * URL itself is the last resort for the vitest-pool-workers harness,
 * which synthesizes neither header.
 */
function discoverOrigin(request: Request): string {
  const protocol = request.headers.get("x-forwarded-proto") ?? "https";
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host");
  if (host) return `${protocol}://${host}`;
  return new URL(request.url).origin;
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

  // MCP discovery surface (PR #8). Three `.well-known/*` documents are
  // declared per the 2026-07-28 MCP specification and the OAuth
  // 2.1 metadata family (RFC 9728, RFC 8414). The endpoints are
  // unconditionally reachable — discovery MUST NOT be gated by the
  // `MCP_ENABLED` flag, because clients cache the metadata before
  // authenticating. Origin derivation prefers `X-Forwarded-Host` so the
  // document survives the Cloudflare edge, falling back to `Host` for
  // local development where the proxy header is absent.
  app.get("/.well-known/oauth-protected-resource", (context) => {
    const origin = discoverOrigin(context.req.raw);
    return Response.json({
      resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/oauth`],
      scopes_supported: [...PERMISSION_KEYS],
      bearer_methods_supported: ["header"],
    });
  });

  // v1 ships a placeholder authorization server: the metadata is well
  // formed and points at the `/.well-known/oauth-authorization-server`
  // endpoints we plan to implement, but the actual authorize/token flow
  // lands in a follow-up. `status: "experimental"` advertises the gap to
  // clients that introspect the document instead of probing the
  // endpoints.
  app.get("/.well-known/oauth-authorization-server", (context) => {
    const origin = discoverOrigin(context.req.raw);
    return Response.json({
      status: "experimental",
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      scopes_supported: [...PERMISSION_KEYS],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      // RFC 8707 Resource Indicators — every token is bound to the
      // `/mcp` endpoint, so a leaked token cannot be replayed against
      // an unrelated resource server under the same deployment.
      resource_documentation: `${origin}/mcp`,
    });
  });

  // Native MCP discovery document. Lets clients learn the transport
  // type and auth scheme without parsing the PRM. Mirrors the
  // `mcp.json` shape used by the official MCP registry.
  app.get("/.well-known/mcp.json", (context) => {
    const origin = discoverOrigin(context.req.raw);
    return Response.json({
      name: "unimailbox",
      version: "0.1.0",
      transport: "streamable-http",
      endpoint: `${origin}/mcp`,
      auth_methods: ["bearer"],
      scopes_supported: [...PERMISSION_KEYS],
    });
  });

  // First-party MCP Streamable HTTP endpoint. Mounted as a sub-route on
  // the existing Hono router so it shares the bootstrap gate, request-id
  // header, and CORS handling with the REST surface. The SDK's
  // `WebStandardStreamableHTTPServerTransport` consumes the raw `Request`
  // directly, so we unwrap the Hono context once and re-enter the
  // standard fetch handler. Disabled by default — operators flip the
  // `MCP_ENABLED` global before this route becomes reachable.
  app.all("/mcp", async (context) => {
    // Hono's `executionCtx` getter throws under vitest-pool-workers'
    // `app.request` harness because the test pool does not pass an
    // ExecutionContext. Production requests always have one. We probe
    // safely with try/catch and pass `undefined` when the context is
    // absent (createAppContext ignores it anyway).
    let execCtx: ExecutionContext | undefined;
    try {
      execCtx = (context as unknown as { executionCtx?: ExecutionContext })
        .executionCtx;
    } catch {
      execCtx = undefined;
    }
    const response = await handleMcpRequest(
      context.req.raw,
      context.env,
      execCtx as ExecutionContext<unknown> | undefined,
    );
    // The MCP transport owns its own response headers; only stamp the
    // request-id if the transport did not already do so.
    if (!response.headers.has("x-request-id")) {
      response.headers.set(
        "x-request-id",
        context.get("requestId") ?? crypto.randomUUID(),
      );
    }
    return response;
  });

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

  app.use("/api/v1/auth/logout-all", requireAuth());
  app.post("/api/v1/auth/logout-all", async (context) => {
    await context
      .get("appContext")
      .identity.logoutAll(context.get("principal").userId);
    return success({ revoked: true });
  });
  app.use("/api/v1/auth/password/reset", requireAuth());
  app.post("/api/v1/auth/password/reset", async (context) => {
    const input = z
      .object({
        currentPassword: z.string().min(12).max(1024),
        newPassword: z.string().min(12).max(1024),
      })
      .parse(await context.req.json());
    await context
      .get("appContext")
      .identity.resetPassword(
        context.get("principal"),
        input.currentPassword,
        input.newPassword,
      );
    return success({ reset: true, sessionsRevoked: true });
  });
  app.use("/api/v1/auth/email", requireAuth());
  app.post("/api/v1/auth/email", async (context) => {
    const input = z
      .object({
        currentPassword: z.string().min(12).max(1024),
        email: z.string().trim().email(),
      })
      .parse(await context.req.json());
    return success({
      ...(await context
        .get("appContext")
        .identity.changeEmail(
          context.get("principal"),
          input.currentPassword,
          input.email,
        )),
      sessionsRevoked: true,
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
  app.get("/api/v1/mailboxes/:mailbox_id/agent", async (context) => {
    const mailboxId = context.req.param("mailbox_id");
    const namespace = context.env.MAILBOX_AGENT;
    if (!namespace) return new Response("agent unavailable", { status: 503 });
    const stub = namespace.get(namespace.idFromName(mailboxId));
    return stub.fetch(context.req.raw);
  });
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
  app.get("/api/v1/mailboxes/:id/members", async (context) =>
    success(
      await context
        .get("appContext")
        .mailboxes.listMembers(
          context.get("principal"),
          context.req.param("id"),
        ),
    ),
  );
  app.post("/api/v1/mailboxes/:id/members", async (context) => {
    const input = MailboxMemberSchema.parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .mailboxes.upsertMember(
          context.get("principal"),
          context.req.param("id"),
          input.userId,
          input.role,
        ),
      { status: 201 },
    );
  });
  app.patch("/api/v1/mailboxes/:id/members/:userId", async (context) => {
    const input = MailboxMemberSchema.pick({ role: true }).parse(
      await context.req.json(),
    );
    return success(
      await context
        .get("appContext")
        .mailboxes.upsertMember(
          context.get("principal"),
          context.req.param("id"),
          context.req.param("userId"),
          input.role,
        ),
    );
  });
  app.delete("/api/v1/mailboxes/:id/members/:userId", async (context) => {
    await context
      .get("appContext")
      .mailboxes.removeMember(
        context.get("principal"),
        context.req.param("id"),
        context.req.param("userId"),
      );
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
  app.get("/api/v1/messages/:id/attachments", async (context) =>
    success(
      await context
        .get("appContext")
        .messages.listAttachments(
          context.get("principal"),
          context.req.param("id"),
        ),
    ),
  );

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

  app.put("/api/v1/attachments/uploads/:id/content", async (context) => {
    await context
      .get("appContext")
      .attachments.uploadContent(
        context.req.param("id"),
        context.req.query("token") ?? "",
        context.req.raw,
      );
    return context.body(null, 204);
  });
  app.use("/api/v1/attachments", requireAuth());
  app.use("/api/v1/attachments/*", requireAuth());
  app.post("/api/v1/attachments/uploads", async (context) =>
    success(
      await context
        .get("appContext")
        .attachments.create(
          context.get("principal"),
          CreateAttachmentUploadSchema.parse(await context.req.json()),
          context.req.url,
        ),
      { status: 201 },
    ),
  );
  app.post("/api/v1/attachments/uploads/:id/complete", async (context) =>
    success(
      await context
        .get("appContext")
        .attachments.complete(
          context.get("principal"),
          context.req.param("id"),
        ),
    ),
  );
  app.delete("/api/v1/attachments/uploads/:id", async (context) => {
    await context
      .get("appContext")
      .attachments.cancel(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });
  app.get("/api/v1/attachments/:id/download", async (context) =>
    context
      .get("appContext")
      .attachments.download(context.get("principal"), context.req.param("id")),
  );

  app.use("/api/v1/drafts", requireAuth());
  app.use("/api/v1/drafts/*", requireAuth());
  app.post("/api/v1/drafts", async (context) => {
    const draft = await context
      .get("appContext")
      .drafts.create(
        context.get("principal"),
        DraftMessageSchema.parse(await context.req.json()),
      );
    const response = success(draft, { status: 201 });
    if ("updated_at" in draft && typeof draft.updated_at === "string") {
      response.headers.set("etag", `"${draft.updated_at}"`);
    }
    return response;
  });
  app.get("/api/v1/drafts", async (context) =>
    success(
      await context.get("appContext").drafts.list(context.get("principal")),
    ),
  );
  app.get("/api/v1/drafts/:id", async (context) => {
    const draft = await context
      .get("appContext")
      .drafts.get(context.get("principal"), context.req.param("id"));
    const response = success(draft);
    if ("updated_at" in draft && typeof draft.updated_at === "string") {
      response.headers.set("etag", `"${draft.updated_at}"`);
    }
    return response;
  });
  app.put("/api/v1/drafts/:id", async (context) => {
    const draft = await context
      .get("appContext")
      .drafts.update(
        context.get("principal"),
        context.req.param("id"),
        DraftMessageSchema.parse(await context.req.json()),
        context.req.header("if-match"),
      );
    const response = success(draft);
    if ("updated_at" in draft && typeof draft.updated_at === "string") {
      response.headers.set("etag", `"${draft.updated_at}"`);
    }
    return response;
  });
  app.delete("/api/v1/drafts/:id", async (context) => {
    await context
      .get("appContext")
      .drafts.remove(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });
  app.post("/api/v1/drafts/:id/send", async (context) =>
    success(
      await context
        .get("appContext")
        .drafts.send(
          context.get("principal"),
          context.req.param("id"),
          context.req.header("if-match"),
          context.req.header("idempotency-key") ?? "",
        ),
    ),
  );
  app.post("/api/v1/drafts/:id/schedule", async (context) => {
    const input = DraftScheduleSchema.parse(await context.req.json());
    const result = await context
      .get("appContext")
      .drafts.schedule(
        context.get("principal"),
        context.req.param("id"),
        input.scheduledAt,
        context.req.header("if-match"),
        context.req.header("idempotency-key") ?? "",
      );
    const response = success(result);
    response.headers.set("etag", `"${result.updatedAt}"`);
    return response;
  });
  app.delete("/api/v1/drafts/:id/schedule", async (context) => {
    const result = await context
      .get("appContext")
      .drafts.cancelSchedule(
        context.get("principal"),
        context.req.param("id"),
        context.req.header("if-match"),
        context.req.header("idempotency-key") ?? "",
      );
    const response = success(result);
    response.headers.set("etag", `"${result.updatedAt}"`);
    return response;
  });

  app.get("/api/v1/admin/cloudflare/oauth/callback", async (context) =>
    context.redirect(
      (
        await context
          .get("appContext")
          .settings.cloudflareOauthCallback(context.req.raw)
      ).toString(),
      303,
    ),
  );

  // PR #8 — agent token REST surface. Three endpoints under
  // `/api/v1/agent_tokens` mirror the public MCP contract:
  //
  // - GET    /api/v1/agent_tokens        list the calling user's tokens
  // - POST   /api/v1/agent_tokens        issue a new scoped token
  // - DELETE /api/v1/agent_tokens/:id    revoke (soft delete)
  //
  // Permission gating lives in `AgentTokenApplicationService` so the
  // contracts stay consistent with the existing `user.manage`-gated
  // admin surface; calling a method without the permission yields a
  // `PERMISSION_DENIED` 403 before any database round-trip.
  app.use("/api/v1/agent_tokens", requireAuth());
  app.use("/api/v1/agent_tokens/*", requireAuth());
  app.get("/api/v1/agent_tokens", async (context) =>
    success(
      await context
        .get("appContext")
        .agentTokens.list(context.get("principal")),
    ),
  );
  app.post("/api/v1/agent_tokens", async (context) => {
    const input = AgentTokenCreateInputSchema.parse(await context.req.json());
    const { view, plaintext } = await context
      .get("appContext")
      .agentTokens.create(context.get("principal"), input);
    return success(
      { ...view, plaintext_token: plaintext, token: plaintext },
      { status: 201 },
    );
  });
  app.delete("/api/v1/agent_tokens/:tokenId", async (context) => {
    await context
      .get("appContext")
      .agentTokens.revoke(
        context.get("principal"),
        context.req.param("tokenId"),
      );
    return context.body(null, 204);
  });

  app.use("/api/v1/admin", requireAuth());
  app.use("/api/v1/admin/*", requireAuth());
  app.use("/api/v1/admin/*", requireAdminIdempotency());

  app.get("/api/v1/admin/messages", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listMessages(
          context.get("principal"),
          AdminMessageListQuerySchema.parse(context.req.query()),
        ),
    ),
  );
  app.get("/api/v1/admin/messages/:id", async (context) => {
    const { id } = AdminMessageParamsSchema.parse({
      id: context.req.param("id"),
    });
    return success(
      await context
        .get("appContext")
        .admin.getMessage(
          context.get("principal"),
          id,
          context.get("requestId") ?? crypto.randomUUID(),
        ),
    );
  });
  app.get("/api/v1/admin/attachments", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listAttachments(
          context.get("principal"),
          AdminAttachmentListQuerySchema.parse(context.req.query()),
        ),
    ),
  );
  app.get("/api/v1/admin/attachments/:id/download", async (context) => {
    const { id } = AdminAttachmentParamsSchema.parse({
      id: context.req.param("id"),
    });
    return context
      .get("appContext")
      .admin.downloadAttachment(
        context.get("principal"),
        id,
        context.get("requestId") ?? crypto.randomUUID(),
      );
  });

  app.get("/api/v1/admin/cloudflare/status", async (context) =>
    success(
      await context
        .get("appContext")
        .settings.listCheckpoints(context.get("principal")),
    ),
  );
  app.post("/api/v1/admin/cloudflare/oauth/start", async (context) =>
    success(
      await context
        .get("appContext")
        .settings.cloudflareOauthStart(
          context.get("principal"),
          context.req.raw,
        ),
    ),
  );
  app.post("/api/v1/admin/cloudflare/oauth/revoke", async (context) =>
    success(
      await context
        .get("appContext")
        .settings.revokeCloudflareOauth(
          context.get("principal"),
          context.req.raw,
        ),
    ),
  );
  app.post("/api/v1/admin/cloudflare/dashboard-link", async (context) => {
    const input = z
      .object({
        accountId: z.string().trim().min(1).max(64),
        zoneId: z.string().trim().min(1).max(64),
        destination: z.enum(["email-routing", "dns", "worker"]),
      })
      .parse(await context.req.json());
    return success({
      url: context
        .get("appContext")
        .settings.dashboardLink(context.get("principal"), input)
        .toString(),
    });
  });
  app.post("/api/v1/admin/cloudflare/verify", async (context) => {
    const input = z
      .object({
        accountId: z.string().trim().min(1).max(64),
        zoneId: z.string().trim().min(1).max(64),
        mode: z.enum(["dashboard", "oauth"]),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .settings.verifyCloudflare(context.get("principal"), input),
    );
  });
  app.post("/api/v1/admin/cloudflare/domains", async (context) => {
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
  app.post("/api/v1/admin/cloudflare/smoke-test/inbound", async (context) => {
    const input = z
      .object({ token: z.string().trim().min(1).max(255).optional() })
      .parse(
        await context.req.json<unknown>().catch(() => ({ token: undefined })),
      );
    return success(
      await context
        .get("appContext")
        .settings.inboundSmokeTest(context.get("principal"), input),
    );
  });
  app.post("/api/v1/admin/cloudflare/brevo", async (context) => {
    const input = ProviderConnectionSchema.extend({
      domainId: SendMessageSchema.shape.mailboxId,
    }).parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .settings.connectBrevo(context.get("principal"), input),
      { status: 201 },
    );
  });
  app.post("/api/v1/admin/cloudflare/smoke-test/outbound", async (context) => {
    const input = z
      .object({
        connectionId: z.string().uuid(),
        from: z.string().trim().email(),
        to: z.string().trim().email(),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .settings.outboundSmokeTest(context.get("principal"), input),
    );
  });
  app.get("/api/v1/admin/infrastructure", async (context) =>
    success(
      await context
        .get("appContext")
        .infrastructure.getStatus(context.get("principal")),
    ),
  );
  app.post("/api/v1/admin/storage/r2/verify", async (context) =>
    success(
      await context
        .get("appContext")
        .infrastructure.verifyR2(context.get("principal")),
    ),
  );

  app.get("/api/v1/admin/users", async (context) =>
    success(
      await context.get("appContext").admin.listUsers(context.get("principal")),
    ),
  );
  app.get("/api/v1/admin/users/role-options", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listUserRoleOptions(context.get("principal")),
    ),
  );
  app.post("/api/v1/admin/users", async (context) => {
    const input = z
      .object({
        email: z.string().trim().email(),
        password: z.string().min(12).max(1024),
        displayName: z.string().trim().min(1).max(120),
        roleIds: z.array(z.string().uuid()).max(20).default([]),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.createUser(context.get("principal"), input),
      { status: 201 },
    );
  });
  app.patch("/api/v1/admin/users/:id", async (context) => {
    const input = z
      .object({
        displayName: z.string().trim().min(1).max(120).optional(),
        status: z.enum(["active", "suspended"]).optional(),
        roleIds: z.array(z.string().uuid()).max(20).optional(),
      })
      .strict()
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.updateUser(
          context.get("principal"),
          context.req.param("id"),
          input,
        ),
    );
  });
  app.delete("/api/v1/admin/users/:id", async (context) => {
    await context
      .get("appContext")
      .admin.deleteUser(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });
  app.get("/api/v1/admin/users/:id/mailboxes", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listUserMailboxes(
          context.get("principal"),
          context.req.param("id"),
        ),
    ),
  );
  app.post("/api/v1/admin/users/:id/mailboxes", async (context) => {
    const input = z
      .object({
        mailboxId: z.string().uuid(),
        role: z.enum(["viewer", "sender", "admin"]),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.addUserMailboxAccess(
          context.get("principal"),
          context.req.param("id"),
          input,
          context.get("requestId") ?? crypto.randomUUID(),
        ),
      { status: 201 },
    );
  });
  app.patch("/api/v1/admin/users/:id/mailboxes/:mailboxId", async (context) => {
    const input = z
      .object({ role: z.enum(["viewer", "sender", "admin"]) })
      .strict()
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.updateUserMailboxAccess(
          context.get("principal"),
          context.req.param("id"),
          context.req.param("mailboxId"),
          input,
          context.get("requestId") ?? crypto.randomUUID(),
        ),
    );
  });
  app.delete(
    "/api/v1/admin/users/:id/mailboxes/:mailboxId",
    async (context) => {
      await context
        .get("appContext")
        .admin.removeUserMailboxAccess(
          context.get("principal"),
          context.req.param("id"),
          context.req.param("mailboxId"),
          context.get("requestId") ?? crypto.randomUUID(),
        );
      return context.body(null, 204);
    },
  );

  app.get("/api/v1/admin/roles", async (context) =>
    success(
      await context.get("appContext").admin.listRoles(context.get("principal")),
    ),
  );
  app.post("/api/v1/admin/roles", async (context) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(80),
        description: z.string().max(500).default(""),
        permissions: z.array(z.string()).max(100),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.createRole(context.get("principal"), input),
      { status: 201 },
    );
  });
  app.patch("/api/v1/admin/roles/:id", async (context) => {
    const input = z
      .object({
        description: z.string().max(500),
        permissions: z.array(z.string()).max(100),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.updateRole(
          context.get("principal"),
          context.req.param("id"),
          input,
        ),
    );
  });
  app.delete("/api/v1/admin/roles/:id", async (context) => {
    await context
      .get("appContext")
      .admin.deleteRole(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });

  app.get("/api/v1/admin/domains", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listDomains(context.get("principal")),
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
  app.patch("/api/v1/admin/domains/:id", async (context) => {
    const input = z
      .object({
        status: z.enum(["active", "disabled"]).optional(),
        outboundConnectionId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.updateDomain(
          context.get("principal"),
          context.req.param("id"),
          input,
        ),
    );
  });
  app.post("/api/v1/admin/domains/:id/provider-test", async (context) => {
    const input = z
      .object({ to: z.string().trim().email() })
      .strict()
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.testDomainProvider(
          context.get("principal"),
          context.req.param("id"),
          input.to,
          context.req.header("idempotency-key") ?? crypto.randomUUID(),
        ),
    );
  });
  app.delete("/api/v1/admin/domains/:id", async (context) => {
    await context
      .get("appContext")
      .admin.deleteDomain(context.get("principal"), context.req.param("id"));
    return context.body(null, 204);
  });
  app.get("/api/v1/admin/domains/:id/signature", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.getSignature(context.get("principal"), context.req.param("id")),
    ),
  );
  app.put("/api/v1/admin/domains/:id/signature", async (context) => {
    const input = z
      .object({
        html: z.string().max(200_000),
        text: z.string().max(200_000),
        enabled: z.boolean(),
      })
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.putSignature(
          context.get("principal"),
          context.req.param("id"),
          input,
        ),
    );
  });

  app.get("/api/v1/admin/settings", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.getSettings(context.get("principal")),
    ),
  );
  app.patch("/api/v1/admin/settings", async (context) =>
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
            max_mailboxes_per_user: z
              .number()
              .int()
              .min(1)
              .max(1_000)
              .optional(),
            max_attachments_per_message: z
              .number()
              .int()
              .min(1)
              .max(100)
              .optional(),
            max_attachment_bytes: z
              .number()
              .int()
              .min(1)
              .max(512 * 1024 * 1024)
              .optional(),
            sender_blocklist_json: z.array(z.string()).max(10_000).optional(),
            subject_blocklist_json: z.array(z.string()).max(10_000).optional(),
            content_blocklist_json: z.array(z.string()).max(10_000).optional(),
          })
          .strict()
          .parse(await context.req.json()),
      ),
    ),
  );

  app.get("/api/v1/admin/provider-connections", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listProviderConnections(context.get("principal")),
    ),
  );
  app.get("/api/v1/admin/providers", async (context) =>
    success(
      context
        .get("appContext")
        .admin.listProviderCatalog(context.get("principal")),
    ),
  );
  app.post("/api/v1/admin/provider-connections", async (context) => {
    const input = ProviderConnectionSchema.extend({
      config: z.record(z.unknown()).optional(),
    }).parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.createProviderConnection(context.get("principal"), input),
      { status: 201 },
    );
  });
  app.patch("/api/v1/admin/provider-connections/:id", async (context) => {
    const input = z
      .object({
        status: z.enum(["active", "disabled"]).optional(),
        apiKey: z.string().min(8).optional(),
        webhookSecret: z.string().min(8).optional(),
      })
      .strict()
      .parse(await context.req.json());
    return success(
      await context
        .get("appContext")
        .admin.updateProviderConnection(
          context.get("principal"),
          context.req.param("id"),
          input,
        ),
    );
  });
  app.post("/api/v1/admin/providers/sync", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.syncProviders(context.get("principal")),
    ),
  );
  app.get("/api/v1/admin/webhook-events", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listWebhookEvents(
          context.get("principal"),
          Number.parseInt(context.req.query("limit") ?? "100", 10),
        ),
    ),
  );
  app.delete("/api/v1/admin/webhook-events/:id", async (context) => {
    await context
      .get("appContext")
      .admin.deleteWebhookEvent(
        context.get("principal"),
        context.req.param("id"),
      );
    return context.body(null, 204);
  });
  app.get("/api/v1/admin/audit-events", async (context) =>
    success(
      await context
        .get("appContext")
        .admin.listAuditEvents(context.get("principal"), {
          limit: Number.parseInt(context.req.query("limit") ?? "100", 10),
          query: context.req.query("q"),
        }),
    ),
  );
  app.get("/api/v1/admin/analytics", async (context) =>
    success(
      await context.get("appContext").admin.analytics(context.get("principal")),
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
    return errorResponse(error, requestId);
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
