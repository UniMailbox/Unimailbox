import { describe, expect, it } from "vitest";
import { ListThreadsInputSchema } from "../../../../src/modules/mcp/tools/list-threads";

describe("list_threads input schema", () => {
  it("applies the default limit when omitted", () => {
    const parsed = ListThreadsInputSchema.parse({ mailbox_id: "mb-1" });
    expect(parsed.limit).toBe(50);
  });

  it("caps the limit at 100", () => {
    expect(() =>
      ListThreadsInputSchema.parse({ mailbox_id: "mb-1", limit: 101 }),
    ).toThrow();
    expect(() =>
      ListThreadsInputSchema.parse({ mailbox_id: "mb-1", limit: 0 }),
    ).toThrow();
  });

  it("accepts a cursor", () => {
    const parsed = ListThreadsInputSchema.parse({
      mailbox_id: "mb-1",
      cursor: "abc.def",
    });
    expect(parsed.cursor).toBe("abc.def");
  });
});
