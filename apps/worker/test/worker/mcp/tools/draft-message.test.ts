import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { draftMessageTool } from "../../../../src/modules/mcp/tools/write-common";

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.send"]),
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

describe("draft_message", () => {
  it("creates a draft through the draft application service", async () => {
    const create = vi.fn().mockResolvedValue({ id: "draft-1" });
    const env = { DB: dbStub() };
    const ctx = {
      principal,
      requestId: "request-1",
      env,
      modules: { env, drafts: { create } },
    } as never;

    const result = await draftMessageTool(ctx).handler(
      {
        mailbox_id: "mailbox-1",
        to: ["recipient@example.com"],
        subject: "Draft",
        text_body: "Body",
        idempotency_key: "draft-key-1",
      },
      { sessionId: null, requestId: "request-1" },
    );

    expect(create).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        mailboxId: "mailbox-1",
        to: ["recipient@example.com"],
        subject: "Draft",
        text: "Body",
      }),
    );
    expect(result.structuredContent).toEqual({
      draft_id: "draft-1",
      replayed: false,
    });
  });
});
