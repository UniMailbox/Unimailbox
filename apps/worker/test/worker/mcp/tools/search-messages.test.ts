import { describe, expect, it } from "vitest";
import {
  parseSearchQuery,
  SearchMessagesInputSchema,
  buildSearchMessagesQuery,
} from "../../../../src/modules/mcp/tools/search-messages";

describe("search_messages query parser", () => {
  it("extracts from:, subject:, and newer_than: tokens", () => {
    const parsed = parseSearchQuery(
      "from:alice subject:invoice newer_than:7d",
      Date.UTC(2026, 6, 30),
    );
    expect(parsed.from).toBe("alice");
    expect(parsed.subject).toBe("invoice");
    expect(parsed.sinceIso).toBeDefined();
  });

  it("collects remaining tokens as free-text fragments", () => {
    const parsed = parseSearchQuery("hello world", Date.UTC(2026, 0, 1));
    expect(parsed.freeText).toEqual(["hello", "world"]);
    expect(parsed.from).toBeUndefined();
  });

  it("supports hour-based newer_than", () => {
    const start = Date.UTC(2026, 0, 1, 12);
    const parsed = parseSearchQuery("newer_than:2h", start);
    const expected = new Date(start - 2 * 60 * 60 * 1000).toISOString();
    expect(parsed.sinceIso).toBe(expected);
  });

  it("supports week and month newer_than units", () => {
    const start = Date.UTC(2026, 0, 1);
    expect(parseSearchQuery("newer_than:1w", start).sinceIso).toBe(
      new Date(start - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(parseSearchQuery("newer_than:2m", start).sinceIso).toBe(
      new Date(start - 60 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("ignores malformed newer_than tokens", () => {
    const parsed = parseSearchQuery("newer_than:garbage", Date.UTC(2026, 0, 1));
    expect(parsed.sinceIso).toBeUndefined();
  });

  it("strips wrapping double quotes from a token", () => {
    const parsed = parseSearchQuery('"hello there"', Date.UTC(2026, 0, 1));
    expect(parsed.freeText).toEqual(["hello there"]);
  });

  it("returns an empty structured form for an empty query", () => {
    expect(parseSearchQuery("", Date.UTC(2026, 0, 1))).toEqual({
      freeText: [],
    });
  });
});

describe("search_messages SQL builder", () => {
  const stubCtx = {
    modules: {
      cursors: {
        encode: async (p: { createdAt: string; id: string }) =>
          `cursor|${p.createdAt}|${p.id}`,
        decode: async (c: string) => {
          const parts = c.split("|");
          if (parts.length !== 3 || parts[0] !== "cursor")
            throw new Error("bad");
          return { createdAt: parts[1] ?? "", id: parts[2] ?? "" };
        },
      },
    },
  } as never;

  it("returns a base query for the mailbox only", async () => {
    const input = SearchMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      query: "hello",
    });
    const parsed = parseSearchQuery(input.query);
    const { sql, params } = await buildSearchMessagesQuery(
      stubCtx,
      input,
      parsed,
    );
    expect(sql).toContain("mm.mailbox_id = ?");
    expect(sql).toContain("LIMIT ?");
    expect(params).toEqual(["mb-1", "%hello%", "%hello%", 51]);
  });

  it("appends LIKE clauses for free-text fragments", async () => {
    const input = SearchMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      query: "from:alice invoice",
    });
    const parsed = parseSearchQuery(input.query);
    const { sql, params } = await buildSearchMessagesQuery(
      stubCtx,
      input,
      parsed,
    );
    expect(sql).toContain("m.from_address LIKE ?");
    expect(sql).toContain("subject LIKE");
    expect(sql).toContain("text_body LIKE");
    expect(params).toContain("%alice%");
    expect(params).toContain("%invoice%");
  });

  it("honours the since bound from newer_than:", async () => {
    const start = Date.UTC(2026, 0, 1);
    const input = SearchMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      query: "newer_than:3d",
    });
    const parsed = parseSearchQuery(input.query, start);
    const { sql, params } = await buildSearchMessagesQuery(
      stubCtx,
      input,
      parsed,
    );
    expect(sql).toContain(
      "COALESCE(m.received_at, m.sent_at, m.created_at) >= ?",
    );
    expect(params).toContain(
      new Date(start - 3 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("strips surrounding quotes from from:/subject: values", async () => {
    const input = SearchMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      query: 'from:"alice@example.com" subject:"invoice Q4"',
    });
    const parsed = parseSearchQuery(input.query);
    expect(parsed.from).toBe("alice@example.com");
    expect(parsed.subject).toBe("invoice Q4");
    const { params } = await buildSearchMessagesQuery(stubCtx, input, parsed);
    expect(params).toContain("%alice@example.com%");
    expect(params).toContain("%invoice Q4%");
  });

  it("applies the cursor keyset predicate when a cursor is supplied", async () => {
    const input = SearchMessagesInputSchema.parse({
      mailbox_id: "mb-1",
      query: "hello",
      cursor: "cursor|2026-03-01T00:00:00Z|msg-42",
    });
    const parsed = parseSearchQuery(input.query);
    const { sql, params } = await buildSearchMessagesQuery(
      stubCtx,
      input,
      parsed,
    );
    expect(sql).toContain(
      "(m.created_at < ? OR (m.created_at = ? AND m.id < ?))",
    );
    expect(params).toContain("2026-03-01T00:00:00Z");
    expect(params).toContain("msg-42");
  });
});
