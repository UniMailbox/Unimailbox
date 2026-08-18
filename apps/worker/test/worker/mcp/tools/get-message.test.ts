import { describe, expect, it } from "vitest";
import { GetMessageInputSchema } from "../../../../src/modules/mcp/tools/get-message";

describe("get_message input schema", () => {
  it("defaults format to 'full' when omitted", () => {
    const parsed = GetMessageInputSchema.parse({ message_id: "m-1" });
    expect(parsed.format).toBe("full");
  });

  it("rejects formats outside the documented enum", () => {
    expect(() =>
      GetMessageInputSchema.parse({ message_id: "m-1", format: "raw" }),
    ).not.toThrow();
    expect(() =>
      GetMessageInputSchema.parse({ message_id: "m-1", format: "minimal" }),
    ).not.toThrow();
    expect(() =>
      GetMessageInputSchema.parse({ message_id: "m-1", format: "bogus" }),
    ).toThrow();
  });

  it("requires a non-empty message_id", () => {
    expect(() => GetMessageInputSchema.parse({ message_id: "" })).toThrow();
  });

  it("does not surface html_body in minimal format", () => {
    const parsed = GetMessageInputSchema.parse({
      message_id: "m-1",
      format: "minimal",
    });
    expect(parsed).not.toHaveProperty("html_body");
  });
});
