import { describe, expect, it } from "vitest";
import {
  buildListMessagesQuery,
  ListMessagesInputSchema,
} from "../../../../src/modules/mcp/tools/list-messages";

const STUB_CURSORS = {
  encode: async (payload: { createdAt: string; id: string }) =>
    `cursor|${payload.createdAt}|${payload.id}`,
  decode: async (cursor: string) => {
    const parts = cursor.split("|");
    if (parts.length !== 3 || parts[0] !== "cursor") {
      throw new Error("invalid cursor");
    }
    return { createdAt: parts[1] ?? "", id: parts[2] ?? "" };
  },
};

function stubCtx() {
  return {
    modules: { cursors: STUB_CURSORS },
  } as never;
}

describe("list_messages SQL builder", () => {
  it("returns a baseline query for inbox-only listing", async () => {
    const input = ListMessagesInputSchema.parse({ mailbox_id: "mb-1" });
    const { sql, params } = await buildListMessagesQuery(stubCtx(), input);
    expect(sql).toContain("mm.mailbox_id = ?");
    expect(sql).toContain("mm.folder = ?");
    expect(sql).toContain("ORDER BY m.created_at DESC, m.id DESC");
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual(["mb-1", "inbox", 51]);
  });

  it("appends since/before filters as COALESCE bounds", async () => {
    const input = ListMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      since: "2026-01-01T00:00:00Z",
      before: "2026-02-01T00:00:00Z",
    });
    const { sql, params } = await buildListMessagesQuery(stubCtx(), input);
    expect(sql).toContain(
      "COALESCE(m.received_at, m.sent_at, m.created_at) >= ?",
    );
    expect(sql).toContain(
      "COALESCE(m.received_at, m.sent_at, m.created_at) < ?",
    );
    expect(params).toContain("2026-01-01T00:00:00Z");
    expect(params).toContain("2026-02-01T00:00:00Z");
  });

  it("adds LIKE filters for from/subject and a label_id folder override", async () => {
    const input = ListMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      from: "alice@example.com",
      subject: "invoice",
      label_id: "sent",
    });
    const { sql, params } = await buildListMessagesQuery(stubCtx(), input);
    expect(sql).toContain("m.from_address LIKE ?");
    expect(sql).toContain("m.subject LIKE ?");
    expect(params).toContain("%alice@example.com%");
    expect(params).toContain("%invoice%");
    expect(params).toContain("sent");
  });

  it("clamps the limit window to one row past the user cap (next-cursor detection)", async () => {
    const input = ListMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      limit: 25,
    });
    const { params } = await buildListMessagesQuery(stubCtx(), input);
    expect(params.at(-1)).toBe(26);
  });

  it("rejects invalid mailbox_id types", () => {
    expect(() => ListMessagesInputSchema.parse({})).toThrow();
    expect(() => ListMessagesInputSchema.parse({ mailbox_id: "" })).toThrow();
  });

  it("rejects unknown label_id values", () => {
    expect(() =>
      ListMessagesInputSchema.parse({ mailbox_id: "mb-1", label_id: "spam" }),
    ).toThrow();
  });

  it("applies the cursor keyset predicate when a cursor is supplied", async () => {
    const input = ListMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      cursor: "cursor|2026-03-01T00:00:00Z|msg-42",
    });
    const { sql, params } = await buildListMessagesQuery(stubCtx(), input);
    expect(sql).toContain(
      "(m.created_at < ? OR (m.created_at = ? AND m.id < ?))",
    );
    expect(params).toContain("2026-03-01T00:00:00Z");
    expect(params).toContain("msg-42");
  });
});
