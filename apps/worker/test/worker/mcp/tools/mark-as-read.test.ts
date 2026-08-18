import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { markAsReadTool } from "../../../../src/modules/mcp/tools/write-tools";

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.read"]),
};

describe("mark_as_read", () => {
  it("sets the requested read state", async () => {
    const setRead = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      principal,
      requestId: "request-1",
      env: {},
      modules: { messages: { setRead } },
    } as never;

    const result = await markAsReadTool(ctx).handler(
      { message_id: "message-1", value: false },
      { sessionId: null, requestId: "request-1" },
    );

    expect(setRead).toHaveBeenCalledWith(principal, "message-1", false);
    expect(result.structuredContent).toEqual({
      message_id: "message-1",
      value: false,
    });
  });
});
