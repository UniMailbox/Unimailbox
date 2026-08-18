import { describe, expect, it, vi } from "vitest";
import { extractActionItems } from "../../../src/modules/agent/extract-actions";

type Run = (model: string, inputs: unknown) => Promise<unknown>;

describe("extractActionItems", () => {
  it("returns the parsed list of action items", async () => {
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify([
        { text: "review", due: "tomorrow", assignee: "alice" },
        { text: "skip" },
        { bad: true },
      ]),
    });
    const out = await extractActionItems({ AI: { run } } as never, "body");
    expect(out).toEqual([
      { text: "review", due: "tomorrow", assignee: "alice" },
      { text: "skip" },
    ]);
  });

  it("returns empty array on empty JSON array", async () => {
    const run = vi.fn().mockResolvedValue({ response: "[]" });
    await expect(
      extractActionItems({ AI: { run } } as never, "body"),
    ).resolves.toEqual([]);
  });
});
