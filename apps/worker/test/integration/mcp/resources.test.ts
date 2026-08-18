import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InstallationStep, type Principal } from "@unimailbox/contracts";
import { TokenService } from "../../../src/modules/identity";
import { createHttpApp, type HttpAppContext } from "../../../src/http/router";
import { makeEnv } from "../env-fixture";

/**
 * Resource-specific integration coverage. The dispatcher hand-rolled in
 * `apps/worker/src/modules/mcp/server.ts` is exercised end-to-end against
 * the Streamable HTTP transport.
 */

declare global {
  // eslint-disable-next-line no-var
  var MCP_ENABLED: boolean | undefined;
}

const userId = "11111111-1111-4111-8111-111111111111";
const tokens = new TokenService("x".repeat(32));
const domainId = "22222222-2222-4222-8222-222222222222";

function ctxFactory(): HttpAppContext {
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
        tokens.verifyAccessToken(token),
    },
    identity: {} as HttpAppContext["identity"],
    mailboxes: {} as HttpAppContext["mailboxes"],
    messages: {} as HttpAppContext["messages"],
    attachments: {} as HttpAppContext["attachments"],
    drafts: {} as HttpAppContext["drafts"],
    webhooks: {} as HttpAppContext["webhooks"],
    admin: {} as HttpAppContext["admin"],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as HttpAppContext;
}

async function bootstrap() {
  return createHttpApp(async () => ctxFactory());
}

async function insertUser() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (id, email, password_hash, password_algorithm, password_salt, password_iterations, status, display_name, created_at, updated_at)
     VALUES (?, ?, 'x', 'pbkdf2-sha256', 'x', 1, 'active', 'Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(userId, "owner@example.com")
    .run();
}

async function insertMailbox(id: string, address: string) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO domains (id, name, status)
     VALUES (?, 'example.com', 'active')`,
  )
    .bind(domainId)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mailboxes (
       id, domain_id, owner_user_id, address, display_name, status
     ) VALUES (?, ?, ?, ?, 'Inbox', 'active')`,
  )
    .bind(id, domainId, userId, address)
    .run();
}

async function insertMessage(opts: {
  messageId: string;
  threadId?: string;
  mailboxMessageId: string;
  mailboxId: string;
  from?: string;
  subject?: string;
  text?: string;
  folder?: "inbox" | "sent" | "drafts" | "archive" | "trash";
}) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (
       id, thread_id, from_address, from_name, subject, html_body,
       text_body, status
     ) VALUES (?, ?, ?, 'Sender', ?, '<p>x</p>', ?, 'received')`,
  )
    .bind(
      opts.messageId,
      opts.threadId ?? opts.messageId,
      opts.from ?? "sender@example.com",
      opts.subject ?? "Hello",
      opts.text ?? "body",
    )
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO mailbox_messages (
       id, mailbox_id, message_id, folder
     ) VALUES (?, ?, ?, ?)`,
  )
    .bind(
      opts.mailboxMessageId,
      opts.mailboxId,
      opts.messageId,
      opts.folder ?? "inbox",
    )
    .run();
}

async function jwtFor(principal: Principal) {
  return tokens.createAccessToken({
    userId: principal.userId,
    email: principal.email,
    permissions: [...principal.permissions],
  });
}

function rpcBody(id: number, method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params ? { params } : {}),
  };
}

async function postRpc(
  app: Awaited<ReturnType<typeof bootstrap>>,
  body: Record<string, unknown>,
  bearer: string,
) {
  return app.request(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    },
    makeEnv(),
  );
}

function parseFrames(body: string): Array<Record<string, unknown>> {
  if (body.startsWith("{")) {
    try {
      return [JSON.parse(body) as Record<string, unknown>];
    } catch {
      return [];
    }
  }
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s*/, ""))
    .map((frame) => {
      try {
        return JSON.parse(frame) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

function frameById(
  body: string,
  id: number,
): Record<string, unknown> | undefined {
  return parseFrames(body).find((frame) => frame && frame.id === id);
}

describe("MCP resources (Streamable HTTP)", () => {
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

  it("resources/templates/list exposes all five templates", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await postRpc(
      app,
      rpcBody(1, "resources/templates/list"),
      jwt,
    );
    expect(response.status).toBe(200);
    const frame = frameById(await response.text(), 1);
    const templates = (
      frame?.result as { resourceTemplates: Array<{ uriTemplate: string }> }
    )?.resourceTemplates;
    const uris = templates?.map((t) => t.uriTemplate) ?? [];
    expect(uris).toEqual(
      expect.arrayContaining([
        "unimailbox://mailboxes",
        "unimailbox://mailboxes/{mailbox_id}/messages",
        "unimailbox://messages/{message_id}",
        "unimailbox://threads/{thread_id}",
        "unimailbox://labels",
      ]),
    );
  });

  it("resources/read unimailbox://labels returns system + user labels", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await postRpc(
      app,
      rpcBody(2, "resources/read", { uri: "unimailbox://labels" }),
      jwt,
    );
    expect(response.status).toBe(200);
    const frame = frameById(await response.text(), 2);
    const contents = (frame?.result as { contents: Array<{ text: string }> })
      ?.contents;
    const parsed = JSON.parse(contents?.[0]?.text ?? "{}") as {
      system: Array<{ id: string }>;
      user_labels: Array<{ id: string }>;
    };
    expect(parsed.system.map((label) => label.id)).toEqual([
      "inbox",
      "sent",
      "drafts",
      "archive",
      "trash",
    ]);
    expect(parsed.user_labels).toEqual([]);
  });

  it("resources/read unimailbox://mailboxes/{id}/messages returns previews", async () => {
    const app = await bootstrap();
    const mailboxId = "33333333-3333-4333-8333-333333333333";
    await insertMailbox(mailboxId, "owner@example.com");
    await insertMessage({
      messageId: "44444444-4444-4444-8444-444444444444",
      mailboxMessageId: "55555555-5555-4555-8555-555555555555",
      mailboxId,
      subject: "Hello",
      text: "Reach me at 13800138000",
    });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await postRpc(
      app,
      rpcBody(3, "resources/read", {
        uri: `unimailbox://mailboxes/${mailboxId}/messages`,
      }),
      jwt,
    );
    expect(response.status).toBe(200);
    const frame = frameById(await response.text(), 3);
    const contents = (frame?.result as { contents: Array<{ text: string }> })
      ?.contents;
    const items = JSON.parse(contents?.[0]?.text ?? "[]") as Array<{
      id: string;
      subject: string;
      preview: string;
    }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ subject: "Hello" });
    expect(items[0]?.preview).toContain("[phone-cn]");
  });

  it("resources/read unimailbox://messages/{id} returns a wrapped body", async () => {
    const app = await bootstrap();
    const mailboxId = "66666666-6666-4666-8666-666666666666";
    await insertMailbox(mailboxId, "owner@example.com");
    await insertMessage({
      messageId: "77777777-7777-4777-8777-777777777777",
      mailboxMessageId: "88888888-8888-4888-8888-888888888888",
      mailboxId,
      subject: "Body",
      text: "Email me at alice@example.com",
    });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await postRpc(
      app,
      rpcBody(4, "resources/read", {
        uri: "unimailbox://messages/77777777-7777-4777-8777-777777777777",
      }),
      jwt,
    );
    expect(response.status).toBe(200);
    const frame = frameById(await response.text(), 4);
    const contents = (frame?.result as { contents: Array<{ text: string }> })
      ?.contents;
    const payload = JSON.parse(contents?.[0]?.text ?? "{}") as {
      body?: string;
      preview?: string;
    };
    expect(payload.body).toContain("BEGIN_UNTRUSTED_EMAIL");
    expect(payload.body).toContain("END_UNTRUSTED_EMAIL");
    expect(payload.body).toContain("[email]");
    expect(payload.preview).toContain("[email]");
  });

  it("resources/read returns not_found for an unknown message", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await postRpc(
      app,
      rpcBody(5, "resources/read", {
        uri: "unimailbox://messages/00000000-0000-4000-8000-000000000000",
      }),
      jwt,
    );
    expect(response.status).toBe(200);
    const frame = frameById(await response.text(), 5);
    expect(frame?.result).toMatchObject({
      isError: true,
      structuredContent: { code: "not_found" },
    });
  });
});
