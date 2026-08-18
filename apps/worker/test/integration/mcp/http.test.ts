import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InstallationStep, type Principal } from "@unimailbox/contracts";
import { TokenService } from "../../../src/modules/identity";
import { createHttpApp, type HttpAppContext } from "../../../src/http/router";
import { makeEnv } from "../env-fixture";

/**
 * Integration tests for the first-party MCP Streamable HTTP endpoint.
 *
 * Coverage:
 * - Unauthenticated POST → 401 with `WWW-Authenticate`.
 * - `initialize` request returns server capabilities.
 * - `tools/list` surfaces `hello_mcp`.
 * - `tools/call hello_mcp` returns the expected payload.
 *
 * The endpoint is force-enabled for this suite by stamping
 * `globalThis.MCP_ENABLED` before the Hono app is constructed. Each
 * test gets its own `mcp.session` row + DB migrations.
 */

declare global {
  // eslint-disable-next-line no-var
  var MCP_ENABLED: boolean | undefined;
}

const userId = "11111111-1111-4111-8111-111111111111";
// Match the signing key baked into `makeEnv` so the JWT minted here is
// verifiable by the real TokenService that `createAppContext` builds.
const tokens = new TokenService("x".repeat(32));

function ctx(): HttpAppContext {
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
    agentTokens: {} as HttpAppContext["agentTokens"],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as HttpAppContext;
}

async function bootstrap() {
  const app = createHttpApp(async () => ctx());
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
  return tokens.createAccessToken({
    userId: principal.userId,
    email: principal.email,
    permissions: [...principal.permissions],
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.1" },
  },
};

const toolsListBody = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
};

const helloCallBody = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "hello_mcp", arguments: { name: "mcp" } },
};

const resourcesListBody = {
  jsonrpc: "2.0",
  id: 4,
  method: "resources/list",
};

const readMailboxesBody = {
  jsonrpc: "2.0",
  id: 5,
  method: "resources/read",
  params: { uri: "unimailbox://mailboxes" },
};

async function insertMailbox(opts: { id: string; address: string }) {
  const domainId = "22222222-2222-4222-8222-222222222222";
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
    .bind(opts.id, domainId, userId, opts.address)
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

async function insertMessageAttachment(opts: {
  attachmentId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO message_attachments (
       id, message_id, upload_id, object_key, filename, mime_type,
       size_bytes, disposition
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'attachment')`,
  )
    .bind(
      opts.attachmentId,
      opts.messageId,
      `attachments/${opts.attachmentId}`,
      opts.filename,
      opts.mimeType,
      opts.sizeBytes,
    )
    .run();
}

describe("MCP Streamable HTTP", () => {
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

  it("returns 401 with WWW-Authenticate when no bearer is presented", async () => {
    const app = await bootstrap();
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(initializeBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("initialize returns server capabilities", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(initializeBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const frames = collectFrames(text);
    const init = frames.find((p) => p && p.id === 1 && p.result) as
      | {
          result: {
            capabilities?: Record<string, unknown>;
            serverInfo?: { name?: string };
          };
        }
      | undefined;
    expect(init?.result?.serverInfo?.name).toBe("unimailbox");
    expect(init?.result?.capabilities).toBeDefined();
  });

  it("tools/list surfaces hello_mcp", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(toolsListBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const tools = extractToolNames(text);
    expect(tools).toContain("hello_mcp");
  });

  it("tools/call hello_mcp returns the greeting payload", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(helloCallBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = extractStructuredContent(text);
    expect(payload).toMatchObject({
      message: "hello, mcp",
      version: "0.1.0",
      principal_id: userId,
    });
  });

  it("tools/list returns the four read tools + hello_mcp", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(toolsListBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const tools = extractToolNames(text);
    expect(tools).toEqual(
      expect.arrayContaining([
        "hello_mcp",
        "list_messages",
        "search_messages",
        "get_message",
        "list_threads",
      ]),
    );
  });

  it("tools/list returns hello, four read tools, and the PR #5 schedule/attachment tools", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set([
        "message.read",
        "message.send",
        "message.delete",
        "schedule.write",
        "attachment.read",
      ]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(toolsListBody),
      },
      makeEnv(),
    );
    const tools = extractToolNames(await response.text());
    expect(tools).toHaveLength(21);
    expect(tools).toEqual(
      expect.arrayContaining([
        "hello_mcp",
        "list_messages",
        "search_messages",
        "get_message",
        "list_threads",
        "send_message",
        "draft_message",
        "reply_message",
        "forward_message",
        "mark_as_read",
        "mark_as_starred",
        "move_message",
        "archive_message",
        "trash_message",
        "schedule_message",
        "cancel_scheduled",
        "list_attachments",
        "download_attachment",
      ]),
    );
  });

  it("tools/list surfaces the PR #6 AI read tools (3 new) alongside the existing set", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set([
        "message.read",
        "message.send",
        "message.delete",
        "schedule.write",
        "attachment.read",
        "ai.read",
      ]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(toolsListBody),
      },
      makeEnv(),
    );
    const tools = extractToolNames(await response.text());
    expect(tools).toHaveLength(21);
    expect(tools).toEqual(
      expect.arrayContaining([
        "summarize_thread",
        "classify_message",
        "extract_action_items",
      ]),
    );
  });

  it("tools/call summarize_thread returns canned mock summary", async () => {
    const mailboxId = "11111111-aaaa-4bbb-8ccc-dddddddddddd";
    const threadId = "22222222-aaaa-4bbb-8ccc-dddddddddddd";
    const messageId = "33333333-aaaa-4bbb-8ccc-dddddddddddd";
    const mailboxMessageId = "44444444-aaaa-4bbb-8ccc-dddddddddddd";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    await insertMessage({
      messageId,
      threadId,
      mailboxMessageId,
      mailboxId,
      subject: "hi",
      text: "hello",
    });
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read", "ai.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: {
            name: "summarize_thread",
            arguments: { thread_id: threadId },
          },
        }),
      },
      makeEnv(),
    );
    const payload = extractStructuredContentById(await response.text(), 20);
    expect(payload).toMatchObject({ model: "8b" });
    expect(typeof payload?.summary).toBe("string");
  });

  it("search_messages falls back to Vectorize when SQL returns no rows", async () => {
    const mailboxId = "55555555-aaaa-4bbb-8ccc-dddddddddddd";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    const vectorizeMock = {
      upsert: async () => ({ mutationId: "mock", ids: [] }),
      query: async () => ({
        matches: [
          {
            id: `${mailboxId}:m1`,
            score: 0.9,
            namespace: mailboxId,
            metadata: { snippet: "vector snippet" },
          },
        ],
        count: 1,
      }),
      insert: async () => ({ mutationId: "mock", ids: [] }),
      delete: async () => ({ mutationId: "mock", ids: [] }),
      getByIds: async () => [],
      describe: async () => ({
        name: "unimailbox-messages",
        description: "mock",
        config: { dimensions: 768, metric: "cosine" },
        createdOn: new Date(0).toISOString(),
        vectorsCount: 1,
      }),
    };
    const env = { ...makeEnv(), VECTORIZE: vectorizeMock as never };
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "search_messages",
            arguments: { mailbox_id: mailboxId, query: "anything" },
          },
        }),
      },
      env,
    );
    const payload = extractStructuredContentById(await response.text(), 21);
    expect(payload).toMatchObject({
      messages: [],
      semantic: [{ id: `${mailboxId}:m1`, score: 0.9 }],
    });
  });

  it("tools/call mark_as_read updates an inserted message", async () => {
    const app = await bootstrap();
    const mailboxId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const messageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const mailboxMessageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    await insertMessage({ messageId, mailboxMessageId, mailboxId });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "mark_as_read",
            arguments: { message_id: messageId, value: true },
          },
        }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(extractStructuredContentById(await response.text(), 8)).toEqual({
      message_id: messageId,
      value: true,
    });
    const state = await env.DB.prepare(
      `SELECT is_read FROM message_user_state
       WHERE mailbox_message_id = ? AND user_id = ?`,
    )
      .bind(mailboxMessageId, userId)
      .first<{ is_read: number }>();
    expect(state?.is_read).toBe(1);
  });

  it("tools/call send_message without a token returns a preview and token", async () => {
    const app = await bootstrap();
    const mailboxId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.send"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: {
              mailbox_id: mailboxId,
              to: ["recipient@example.com"],
              subject: "Preview",
              text_body: "Preview body",
              idempotency_key: "integration-send-key",
            },
          },
        }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(
      extractStructuredContentById(await response.text(), 9),
    ).toMatchObject({
      confirmation_required: true,
      confirmation_token: expect.any(String),
      preview: {
        mailbox_id: mailboxId,
        to: ["recipient@example.com"],
        subject: "Preview",
        text_body: "Preview body",
      },
    });
  });

  it("tools/call send_message rejects a malformed confirmation token", async () => {
    const app = await bootstrap();
    const mailboxId = "12121212-1212-4212-8212-121212121212";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.send"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: {
              mailbox_id: mailboxId,
              to: ["recipient@example.com"],
              subject: "No send",
              text_body: "Body",
              idempotency_key: "integration-send-bad-token",
              confirmation_token: "malformed-token",
            },
          },
        }),
      },
      makeEnv(),
    );
    const result = extractToolResultById(await response.text(), 10);
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({
      code: "confirmation_invalid",
    });
  });

  it("resources/list surfaces unimailbox://mailboxes", async () => {
    const app = await bootstrap();
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(resourcesListBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const uris = extractResourceUris(text, 4);
    expect(uris).toEqual(expect.arrayContaining(["unimailbox://mailboxes"]));
  });

  it("resources/read unimailbox://mailboxes returns the principal's mailboxes", async () => {
    const app = await bootstrap();
    const mailboxId = "55555555-5555-4555-8555-555555555555";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(readMailboxesBody),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = extractResourceContents(text, 5);
    const parsed = JSON.parse(payload[0]?.text ?? "[]");
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({
      id: mailboxId,
      address: "owner@example.com",
      role: "owner",
    });
  });

  it("tools/call list_messages returns previews for the principal's mailbox", async () => {
    const app = await bootstrap();
    const mailboxId = "66666666-6666-4666-8666-666666666666";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    await insertMessage({
      messageId: "77777777-7777-4777-8777-777777777777",
      mailboxMessageId: "88888888-8888-4888-8888-888888888888",
      mailboxId,
      subject: "Hello",
      text: "hello body",
    });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "list_messages",
            arguments: { mailbox_id: mailboxId },
          },
        }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = extractStructuredContentById(text, 6);
    const messages = (payload?.messages ?? []) as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      subject: "Hello",
      preview: "hello body",
    });
  });

  it("tools/call get_message returns the redacted full body", async () => {
    const app = await bootstrap();
    const mailboxId = "99999999-9999-4999-8999-999999999999";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    await insertMessage({
      messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      mailboxMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      mailboxId,
      subject: "Body",
      text: "Reach me at 13800138000",
      from: "alice@example.com",
    });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "get_message",
            arguments: {
              message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            },
          },
        }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = extractStructuredContentById(text, 7);
    expect(payload).toMatchObject({
      subject: "Body",
      from: "[email]",
    });
    expect(JSON.stringify(payload)).toContain("[phone-cn]");
  });

  it("tools/call list_attachments returns metadata for an inserted message", async () => {
    const app = await bootstrap();
    const mailboxId = "10101010-1010-4101-8101-101010101010";
    const messageId = "20202020-2020-4202-8202-202020202020";
    const mailboxMessageId = "30303030-3030-4303-8303-303030303030";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    await insertMessage({
      messageId,
      mailboxMessageId,
      mailboxId,
      subject: "Attachment test",
      text: "see attached",
    });
    await insertMessageAttachment({
      attachmentId: "40404040-4040-4404-8404-404040404040",
      messageId,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read", "attachment.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: {
            name: "list_attachments",
            arguments: { message_id: messageId },
          },
        }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const payload = extractStructuredContentById(await response.text(), 11);
    const attachments = (payload?.attachments ?? []) as Array<
      Record<string, unknown>
    >;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: "40404040-4040-4404-8404-404040404040",
      filename: "invoice.pdf",
      mime_type: "application/pdf",
      size_bytes: 4096,
      disposition: "attachment",
    });
  });

  it("tools/call download_attachment rejects when the feature flag is off", async () => {
    const app = await bootstrap();
    const mailboxId = "50505050-5050-4505-8505-505050505050";
    const messageId = "60606060-6060-4606-8606-606060606060";
    const mailboxMessageId = "70707070-7070-4707-8707-707070707070";
    await insertMailbox({ id: mailboxId, address: "owner@example.com" });
    await insertMessage({
      messageId,
      mailboxMessageId,
      mailboxId,
    });
    await insertMessageAttachment({
      attachmentId: "80808080-8080-4808-8808-808080808080",
      messageId,
      filename: "small.pdf",
      mimeType: "application/pdf",
      sizeBytes: 256,
    });
    const jwt = await jwtFor({
      userId,
      email: "owner@example.com",
      permissions: new Set(["message.read", "attachment.read"]),
    });
    const response = await app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: {
            name: "download_attachment",
            arguments: {
              attachment_id: "80808080-8080-4808-8808-808080808080",
            },
          },
        }),
      },
      makeEnv(),
    );
    const result = extractToolResultById(await response.text(), 12);
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ code: "forbidden" });
  });
});

function extractToolNames(body: string): string[] {
  const parsed = collectFrames(body);
  // JSON mode emits one envelope; SSE mode emits one frame per event.
  // The list response uses id === 2.
  const listFrame = parsed.find(
    (p) =>
      p &&
      p.id === 2 &&
      p.result &&
      Array.isArray((p.result as Record<string, unknown>).tools),
  ) as { result: { tools: Array<{ name: string }> } } | undefined;
  return listFrame?.result.tools.map((t) => t.name) ?? [];
}

function extractStructuredContent(
  body: string,
): Record<string, unknown> | null {
  const parsed = collectFrames(body);
  // The call response uses id === 3 and carries the structuredContent
  // envelope alongside the textual `content` array.
  const frame = parsed.find(
    (p) =>
      p &&
      p.id === 3 &&
      p.result &&
      (p.result as Record<string, unknown>).structuredContent,
  ) as { result: { structuredContent: Record<string, unknown> } } | undefined;
  return frame?.result.structuredContent ?? null;
}

function extractToolResultById(
  body: string,
  id: number,
): {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} | null {
  const parsed = collectFrames(body);
  const frame = parsed.find((p) => p && p.id === id && p.result) as
    | {
        result: {
          isError?: boolean;
          structuredContent?: Record<string, unknown>;
        };
      }
    | undefined;
  return frame?.result ?? null;
}

function extractStructuredContentById(
  body: string,
  id: number,
): Record<string, unknown> | null {
  const parsed = collectFrames(body);
  const frame = parsed.find(
    (p) =>
      p &&
      p.id === id &&
      p.result &&
      (p.result as Record<string, unknown>).structuredContent,
  ) as { result: { structuredContent: Record<string, unknown> } } | undefined;
  return frame?.result.structuredContent ?? null;
}

function extractResourceUris(body: string, id: number): string[] {
  const parsed = collectFrames(body);
  const frame = parsed.find(
    (p) =>
      p &&
      p.id === id &&
      p.result &&
      Array.isArray((p.result as Record<string, unknown>).resources),
  ) as { result: { resources: Array<{ uri: string }> } } | undefined;
  return frame?.result.resources.map((r) => r.uri) ?? [];
}

function extractResourceContents(
  body: string,
  id: number,
): Array<{ uri: string; mimeType?: string; text?: string }> {
  const parsed = collectFrames(body);
  const frame = parsed.find((p) => p && p.id === id && p.result) as
    | {
        result: {
          contents: Array<{
            uri: string;
            mimeType?: string;
            text?: string;
          }>;
        };
      }
    | undefined;
  return frame?.result.contents ?? [];
}

/**
 * Parse JSON-RPC responses out of the body. Supports both:
 *  - SSE-streamed frames (`data: { ... }\n\n`) — produced by the
 *    transport when `enableJsonResponse` is false.
 *  - Plain JSON envelopes — produced by the transport when
 *    `enableJsonResponse` is true (PR #2 default; lets the test
 *    harness read the body deterministically).
 */
function collectFrames(body: string): Array<Record<string, unknown>> {
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
