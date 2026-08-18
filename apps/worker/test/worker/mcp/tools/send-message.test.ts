import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { assertScope } from "../../../../src/modules/mcp/auth";
import { McpToolError } from "../../../../src/modules/mcp/errors";
import { sendMessageTool } from "../../../../src/modules/mcp/tools/write-common";

function kvStub(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

function dbStub(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => null,
            run: async () => ({ success: true, meta: { changes: 1 } }),
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

function context(send = vi.fn()) {
  const env = { KV: kvStub(), DB: dbStub() };
  const modules = {
    env,
    messages: { send },
  };
  return {
    principal,
    requestId: "request-1",
    env,
    modules,
  } as never;
}

const args = {
  mailbox_id: "mailbox-1",
  to: ["recipient@example.com"],
  subject: "Hello",
  text_body: "Body",
  idempotency_key: "send-key-1",
};

describe("send_message", () => {
  it("returns a preview and confirmation token without sending", async () => {
    const send = vi.fn();
    const result = await sendMessageTool(context(send)).handler(args, {
      sessionId: null,
      requestId: "request-1",
    });

    expect(result.structuredContent).toMatchObject({
      confirmation_required: true,
      preview: {
        mailbox_id: "mailbox-1",
        to: ["recipient@example.com"],
        subject: "Hello",
        text_body: "Body",
      },
    });
    expect(result.structuredContent?.confirmation_token).toEqual(
      expect.any(String),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("executes after the exact confirmation token is supplied", async () => {
    const send = vi.fn().mockResolvedValue({
      messageId: "message-1",
      status: "sent",
    });
    const ctx = context(send);
    const preview = await sendMessageTool(ctx).handler(args, {
      sessionId: null,
      requestId: "request-1",
    });
    const token = preview.structuredContent?.confirmation_token;
    expect(typeof token).toBe("string");

    const result = await sendMessageTool(ctx).handler(
      { ...args, confirmation_token: token },
      { sessionId: null, requestId: "request-2" },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        mailboxId: "mailbox-1",
        to: ["recipient@example.com"],
        text: "Body",
      }),
      "send-key-1",
    );
    expect(result.structuredContent).toMatchObject({
      result: {
        messageId: "message-1",
        status: "sent",
        replayed: false,
      },
    });
  });

  it("denies a principal without message.send scope", () => {
    const denied: Principal = {
      ...principal,
      permissions: new Set(["message.read"]),
    };
    expect(() => assertScope(denied, ["message.send"])).toThrowError(
      McpToolError,
    );
  });
});
