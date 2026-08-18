import { describe, expect, it, vi } from "vitest";
import { aiRun } from "../../../src/modules/agent/gateway";

type Run = (model: string, inputs: unknown) => Promise<unknown>;
function env(overrides: { gateway?: Run; direct?: Run } = {}) {
  return {
    AI_GATEWAY: overrides.gateway ? { run: overrides.gateway } : undefined,
    AI: overrides.direct ? { run: overrides.direct } : undefined,
  };
}

describe("aiRun gateway fallback", () => {
  it("routes through env.AI_GATEWAY when defined", async () => {
    const gatewayRun = vi.fn().mockResolvedValue({ ok: true });
    const directRun = vi.fn().mockResolvedValue({ ok: false });
    const result = await aiRun(
      env({ gateway: gatewayRun, direct: directRun }) as never,
      "@cf/test",
      { x: 1 },
    );
    expect(result).toEqual({ ok: true });
    expect(gatewayRun).toHaveBeenCalledOnce();
    expect(directRun).not.toHaveBeenCalled();
  });

  it("falls back to env.AI when AI_GATEWAY is absent", async () => {
    const directRun = vi.fn().mockResolvedValue({ ok: "direct" });
    const result = await aiRun(
      env({ direct: directRun }) as never,
      "@cf/test",
      { y: 2 },
    );
    expect(result).toEqual({ ok: "direct" });
    expect(directRun).toHaveBeenCalledOnce();
  });
});
