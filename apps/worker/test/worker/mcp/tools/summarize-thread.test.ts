import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeThreadTool } from "../../../../src/modules/mcp/tools/ai-tools";
import * as summarizeMod from "../../../../src/modules/agent/summarize";

function ctx(
  messages: { subject: string; text_body: string }[] = [
    { subject: "s", text_body: "b" },
  ],
) {
  const all = vi.fn().mockResolvedValue({ results: messages });
  return {
    modules: {
      messages: { get: vi.fn() },
    },
    env: { DB: { prepare: () => ({ bind: () => ({ all }) }) } },
    principal: {
      userId: "u",
      email: "u@x",
      permissions: new Set(["message.read", "ai.read"]),
    },
    requestId: "req",
  };
}

describe("summarizeThreadTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a summary payload and calls summarizeThread", async () => {
    const spy = vi
      .spyOn(summarizeMod, "summarizeThread")
      .mockResolvedValue("summary");
    const tool = summarizeThreadTool(ctx() as never);
    const result = await tool.handler(
      { thread_id: "t1" },
      { sessionId: null, requestId: "req" },
    );
    expect(spy).toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      summary: "summary",
      model: "8b",
    });
  });

  it("rejects missing thread_id", async () => {
    const tool = summarizeThreadTool(ctx() as never);
    await expect(
      tool.handler({}, { sessionId: null, requestId: "r" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
  });
});
