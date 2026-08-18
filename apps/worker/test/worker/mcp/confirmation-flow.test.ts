import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { wrapWithConfirmation } from "../../../src/modules/mcp/confirmation-flow";
import { McpToolError } from "../../../src/modules/mcp/errors";

function kvStub(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.send"]),
};

describe("wrapWithConfirmation", () => {
  it("previews first, then executes once for the matching payload", async () => {
    const ctx = { env: { KV: kvStub() } } as never;
    const previewBuilder = vi.fn().mockReturnValue({ summary: "preview" });
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const args = { message_id: "message-1", confirmation_token: undefined };

    const first = await wrapWithConfirmation(
      ctx,
      principal,
      args,
      previewBuilder,
      execute,
    );
    expect(first).toMatchObject({
      confirmation_required: true,
      preview: { summary: "preview" },
    });
    expect(execute).not.toHaveBeenCalled();
    if (!("confirmation_token" in first)) throw new Error("token missing");

    const second = await wrapWithConfirmation(
      ctx,
      principal,
      { message_id: "message-1", confirmation_token: first.confirmation_token },
      previewBuilder,
      execute,
    );
    expect(second).toEqual({ result: { ok: true } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed token without executing", async () => {
    const ctx = { env: { KV: kvStub() } } as never;
    const execute = vi.fn();
    await expect(
      wrapWithConfirmation(
        ctx,
        principal,
        { message_id: "message-1", confirmation_token: "bad-token" },
        () => ({}),
        execute,
      ),
    ).rejects.toBeInstanceOf(McpToolError);
    expect(execute).not.toHaveBeenCalled();
  });
});
