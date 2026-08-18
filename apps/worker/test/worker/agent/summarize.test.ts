import { describe, expect, it, vi } from "vitest";
import {
  summarizeThread,
  responseText,
  SUMMARY_MODEL,
} from "../../../src/modules/agent/summarize";

type Run = (model: string, inputs: unknown) => Promise<unknown>;

describe("summarizeThread", () => {
  it("returns parsed text and trims to 300 chars", async () => {
    const run = vi.fn().mockResolvedValue({ response: "a".repeat(800) });
    const env = { AI: { run } } as { AI: { run: Run } };
    const out = await summarizeThread(env as never, ["hello"]);
    expect(out).toHaveLength(300);
    expect(run).toHaveBeenCalledWith(
      SUMMARY_MODEL,
      expect.objectContaining({ messages: expect.any(Array) }),
    );
  });

  it("responseText extracts string from common shapes", () => {
    expect(responseText("plain")).toBe("plain");
    expect(responseText({ response: "json" })).toBe("json");
    expect(() => responseText({})).toThrow();
  });
});
