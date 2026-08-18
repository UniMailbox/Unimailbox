import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractActionItemsTool } from "../../../../src/modules/mcp/tools/ai-tools";
import * as extractMod from "../../../../src/modules/agent/extract-actions";

function ctx() {
  return {
    modules: {
      messages: {
        get: vi.fn().mockResolvedValue({ text_body: "body", subject: "subj" }),
      },
    },
    env: { DB: {} },
    principal: {
      userId: "u",
      email: "u@x",
      permissions: new Set(["message.read", "ai.read"]),
    },
    requestId: "req",
  };
}

describe("extractActionItemsTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns extracted items", async () => {
    vi.spyOn(extractMod, "extractActionItems").mockResolvedValue([
      { text: "follow up" },
    ]);
    const tool = extractActionItemsTool(ctx() as never);
    const out = await tool.handler(
      { message_id: "m1" },
      { sessionId: null, requestId: "r" },
    );
    expect(out.structuredContent).toEqual({ items: [{ text: "follow up" }] });
  });

  it("rejects missing message_id", async () => {
    const tool = extractActionItemsTool(ctx() as never);
    await expect(
      tool.handler({}, { sessionId: null, requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});
