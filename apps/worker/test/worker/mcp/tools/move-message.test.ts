import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { moveMessageTool } from "../../../../src/modules/mcp/tools/write-tools";

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.delete"]),
};

function dbStub(): D1Database {
  return {
    prepare() {
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

describe("move_message", () => {
  it("moves a message through the message application service", async () => {
    const move = vi.fn().mockResolvedValue(undefined);
    const env = { DB: dbStub() };
    const ctx = {
      principal,
      requestId: "request-1",
      env,
      modules: { env, messages: { move } },
    } as never;

    const result = await moveMessageTool(ctx).handler(
      {
        message_id: "message-1",
        mailbox_id: "mailbox-1",
        target_folder: "archive",
        idempotency_key: "move-key-1",
      },
      { sessionId: null, requestId: "request-1" },
    );

    expect(move).toHaveBeenCalledWith(
      principal,
      "message-1",
      "mailbox-1",
      "archive",
    );
    expect(result.structuredContent).toMatchObject({
      message_id: "message-1",
      target_folder: "archive",
      replayed: false,
    });
  });
});
