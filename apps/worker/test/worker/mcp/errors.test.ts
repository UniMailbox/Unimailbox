import { describe, expect, it } from "vitest";
import { DomainError } from "@unimailbox/contracts";
import {
  MCP_ERROR_CODES,
  McpToolError,
  toMcpResult,
} from "../../../src/modules/mcp/errors";

describe("McpToolError", () => {
  it("exposes a stable code", () => {
    const error = new McpToolError("rate_limited");
    expect(error.code).toBe("rate_limited");
    expect(error.message).toMatch(/rate/i);
    expect(error.status).toBe(429);
    expect(error).toBeInstanceOf(DomainError);
  });

  it("accepts a custom message and details", () => {
    const error = new McpToolError("forbidden", "custom", { tool: "x" });
    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("custom");
    expect(error.details).toEqual({ tool: "x" });
  });

  it("covers all advertised codes", () => {
    for (const code of MCP_ERROR_CODES) {
      expect(() => new McpToolError(code)).not.toThrow();
    }
  });
});

describe("toMcpResult", () => {
  it("shapes an McpToolError into a CallToolResult with structuredContent", () => {
    const error = new McpToolError("confirmation_required", "send");
    const result = toMcpResult(error);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.code).toBe("confirmation_required");
    expect(result.structuredContent.code).toBe("confirmation_required");
    expect(result.structuredContent.message).toBe("send");
  });

  it("falls back to 'internal' for unknown errors", () => {
    const result = toMcpResult(new Error("boom"));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe("internal");
    expect(result.structuredContent.message).toBe("boom");
  });

  it("wraps generic DomainError into the same shape", () => {
    const result = toMcpResult(new DomainError("CUSTOM_CODE", "custom", 418));
    expect(result.structuredContent.code).toBe("CUSTOM_CODE");
    expect(result.structuredContent.message).toBe("custom");
  });
});
