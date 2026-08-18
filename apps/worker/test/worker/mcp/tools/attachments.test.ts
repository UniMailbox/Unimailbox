import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { McpToolError } from "../../../../src/modules/mcp/errors";
import {
  ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES,
  downloadAttachmentTool,
  listAttachmentsTool,
} from "../../../../src/modules/mcp/tools/attachment-tools";

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.read", "attachment.read"]),
};

interface D1State {
  // Mapping from SQL shape keyword → first/all result.
  results: Record<string, unknown>;
  attachmentBytes: Uint8Array | null;
  attachmentSize: number;
}

function freshD1(): D1State {
  return { results: {}, attachmentBytes: null, attachmentSize: 0 };
}

function buildD1Stub(state: D1State): D1Database {
  return {
    prepare(sql: string) {
      const bound: unknown[] = [];
      const runner = {
        bind(...params: unknown[]) {
          bound.push(...params);
          return runner;
        },
        async first<T>(): Promise<T | null> {
          if (
            sql.includes("FROM mailbox_messages mm") &&
            sql.includes("JOIN mailboxes mb")
          ) {
            return (state.results.mailboxLink ?? null) as T | null;
          }
          if (sql.includes("SELECT ma.id, ma.filename")) {
            return (state.results.attachmentRow ?? null) as T | null;
          }
          if (sql.includes("SELECT mcp_attachment_download_enabled")) {
            return (state.results.settings ?? {
              mcp_attachment_download_enabled: 0,
            }) as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM message_attachments WHERE message_id = ?")) {
            const rows = state.results.messageAttachments ?? [];
            return { results: rows as T[] };
          }
          return { results: [] };
        },
      };
      return runner;
    },
  } as unknown as D1Database;
}

function buildAttachmentStore(state: D1State) {
  return {
    async get() {
      if (!state.attachmentBytes) return null;
      return {
        body: state.attachmentBytes,
        size: state.attachmentSize,
      };
    },
  } as never;
}

function buildCtx(state: D1State) {
  const env = { DB: buildD1Stub(state) };
  return {
    principal,
    requestId: "request-1",
    env,
    modules: { env, attachmentStore: buildAttachmentStore(state) },
  } as never;
}

describe("list_attachments", () => {
  let state: D1State;
  beforeEach(() => {
    state = freshD1();
    state.results.mailboxLink = { mailbox_id: "mailbox-1" };
    state.results.messageAttachments = [
      {
        id: "att-1",
        filename: "invoice.pdf",
        mime_type: "application/pdf",
        size_bytes: 1234,
        disposition: "attachment",
      },
    ];
  });

  it("returns metadata without any binary payload", async () => {
    const result = await listAttachmentsTool(buildCtx(state)).handler(
      { message_id: "msg-1" },
      { sessionId: null, requestId: "request-1" },
    );
    expect(result.structuredContent).toEqual({
      attachments: [
        {
          id: "att-1",
          filename: "invoice.pdf",
          mime_type: "application/pdf",
          size_bytes: 1234,
          disposition: "attachment",
        },
      ],
    });
  });

  it("PII-redacts filenames matching email-like substrings", async () => {
    state.results.messageAttachments = [
      {
        id: "att-2",
        filename: "for alice@example.com.pdf",
        mime_type: "application/pdf",
        size_bytes: 4096,
        disposition: "attachment",
      },
    ];
    const result = await listAttachmentsTool(buildCtx(state)).handler(
      { message_id: "msg-1" },
      { sessionId: null, requestId: "request-1" },
    );
    const first = (
      result.structuredContent as { attachments: Array<{ filename: string }> }
    ).attachments[0]!;
    expect(first.filename).not.toContain("alice@example.com");
    expect(first.filename).toContain("[email]");
  });

  it("throws not_found when the message is not readable", async () => {
    state.results.mailboxLink = null;
    await expect(
      listAttachmentsTool(buildCtx(state)).handler(
        { message_id: "missing" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toThrowError(McpToolError);
  });
});

describe("download_attachment", () => {
  let state: D1State;
  beforeEach(() => {
    state = freshD1();
    state.results.settings = { mcp_attachment_download_enabled: 1 };
    state.results.attachmentRow = {
      id: "att-1",
      filename: "report.pdf",
      mime_type: "application/pdf",
      size_bytes: 100,
      disposition: "attachment",
      object_key: "attachments/att-1",
      mailbox_id: "mailbox-1",
    };
    state.attachmentBytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
    state.attachmentSize = 5;
  });

  it("returns metadata + base64 blob when the feature flag is on", async () => {
    const result = await downloadAttachmentTool(buildCtx(state)).handler(
      { attachment_id: "att-1" },
      { sessionId: null, requestId: "request-1" },
    );
    expect(result.structuredContent).toMatchObject({
      attachment_id: "att-1",
      mime_type: "application/pdf",
      size_bytes: 100,
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as { blob: string; size_bytes: number };
    expect(parsed.blob).toBe("aGVsbG8="); // base64("hello")
    expect(parsed.size_bytes).toBe(100);
  });

  it("throws forbidden when the user has not enabled download", async () => {
    state.results.settings = { mcp_attachment_download_enabled: 0 };
    await expect(
      downloadAttachmentTool(buildCtx(state)).handler(
        { attachment_id: "att-1" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects oversized attachments with invalid_args", async () => {
    state.results.attachmentRow = {
      ...state.results.attachmentRow!,
      size_bytes: ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES + 1,
    };
    await expect(
      downloadAttachmentTool(buildCtx(state)).handler(
        { attachment_id: "att-1" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({
      code: "invalid_args",
      details: {
        cap_bytes: ATTACHMENT_DOWNLOAD_SIZE_CAP_BYTES,
      },
    });
  });

  it("throws not_found when the attachment is not in any mailbox the principal can read", async () => {
    state.results.attachmentRow = null;
    await expect(
      downloadAttachmentTool(buildCtx(state)).handler(
        { attachment_id: "missing" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("throws not_found when the storage backend cannot locate the object", async () => {
    state.attachmentBytes = null;
    await expect(
      downloadAttachmentTool(buildCtx(state)).handler(
        { attachment_id: "att-1" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
