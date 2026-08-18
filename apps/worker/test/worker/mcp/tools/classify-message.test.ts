import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyMessageTool } from "../../../../src/modules/mcp/tools/ai-tools";
import * as classifyMod from "../../../../src/modules/agent/classify";

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

describe("classifyMessageTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the classify payload", async () => {
    vi.spyOn(classifyMod, "classifyMessage").mockResolvedValue({
      labels: ["work"],
      confidence: 0.7,
    });
    const tool = classifyMessageTool(ctx() as never);
    const out = await tool.handler(
      { message_id: "m1" },
      { sessionId: null, requestId: "r" },
    );
    expect(out.structuredContent).toEqual({
      labels: ["work"],
      confidence: 0.7,
    });
  });

  it("rejects missing message_id", async () => {
    const tool = classifyMessageTool(ctx() as never);
    await expect(
      tool.handler({}, { sessionId: null, requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});
