import { describe, expect, it, vi } from "vitest";
import {
  classifyMessage,
  CLASSIFICATION_LABELS,
} from "../../../src/modules/agent/classify";

type Run = (model: string, inputs: unknown) => Promise<unknown>;

describe("classifyMessage", () => {
  it("filters labels to the candidate set", async () => {
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({ labels: ["work", "nope"], confidence: 0.8 }),
    });
    const out = await classifyMessage({ AI: { run } } as never, "body");
    expect(out.labels).toEqual(["work"]);
    expect(out.confidence).toBeCloseTo(0.8);
    expect(CLASSIFICATION_LABELS).toContain("work");
  });

  it("clamps confidence and tolerates invalid payloads", async () => {
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({ labels: "not-array", confidence: 9 }),
    });
    const out = await classifyMessage({ AI: { run } } as never, "x");
    expect(out.labels).toEqual([]);
    expect(out.confidence).toBe(1);
  });
});
