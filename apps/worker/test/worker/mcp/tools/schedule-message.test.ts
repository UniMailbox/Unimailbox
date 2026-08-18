import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { McpToolError } from "../../../../src/modules/mcp/errors";
import type { McpToolContext } from "../../../../src/modules/mcp/context";
import { scheduleMessageTool } from "../../../../src/modules/mcp/tools/schedule-tools";

/**
 * Fixed clock so the schedule window check is deterministic across
 * `schedule_message` test runs. The default system clock would make the
 * tool's `90s` floor flake every minute the test suite happens to run.
 */
const NOW = new Date("2026-08-08T00:00:00.000Z");
const clock = () => new Date(NOW.getTime());

const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["message.send", "schedule.write"]),
};

interface BatchCall {
  sql: string;
  params: unknown[];
}

interface D1State {
  firstRows: Map<string, unknown>;
  batches: BatchCall[];
  // Tracks the most recent idempotency record so a re-call with the
  // same key replays the cached response instead of running again.
  idempotency: {
    key: string;
    request_hash: string;
    body: string;
  } | null;
  prepareResult: { first: unknown; runChanges: number };
}

interface KvState {
  values: Map<string, string>;
}

interface ScheduleTestFakes {
  d1: D1State;
  kv: KvState;
  ctx: McpToolContext;
}

function buildD1Stub(state: D1State): D1Database {
  return {
    prepare(sql: string) {
      const boundParams: unknown[] = [];
      const runner: Record<string, unknown> = {
        sql,
        bind(...params: unknown[]) {
          boundParams.push(...params);
          return runner;
        },
      };
      runner.first = async <T>(): Promise<T | null> => {
        if (sql.includes("FROM mailboxes m") && sql.includes("JOIN domains")) {
          return (state.firstRows.get("mailbox") ?? null) as T | null;
        }
        if (sql.includes("FROM mailboxes") && sql.includes("IN (?")) {
          const rows = state.firstRows.get("internalMailboxes") ?? [];
          return (Array.isArray(rows) ? rows : null) as T | null;
        }
        if (
          sql.includes("FROM idempotency_records") &&
          sql.includes("operation = ?")
        ) {
          // SELECT binds: principal.userId (0), operation (1), key (2).
          const key = String(boundParams[2] ?? "");
          if (state.idempotency && state.idempotency.key === key) {
            return {
              request_hash: state.idempotency.request_hash,
              response_json: JSON.stringify({
                body: state.idempotency.body,
                status: 200,
                contentType: "application/json",
              }),
            } as T;
          }
          return null;
        }
        return (state.firstRows.get(sql) ??
          state.prepareResult.first) as T | null;
      };
      runner.run = async (): Promise<{
        success: boolean;
        meta: { changes: number };
      }> => {
        state.batches.push({ sql, params: boundParams });
        if (sql.startsWith("INSERT INTO idempotency_records")) {
          // INSERT binds: uuid (0), principal.userId (1), operation (2),
          // key (3), hash (4), status (5), body JSON (6).
          const responseBody = String(boundParams[6] ?? "{}");
          const parsed = JSON.parse(responseBody) as { body: string };
          state.idempotency = {
            key: String(boundParams[3] ?? ""),
            request_hash: String(boundParams[4] ?? ""),
            body: parsed.body,
          };
        }
        return {
          success: true,
          meta: { changes: state.prepareResult.runChanges },
        };
      };
      runner.all = async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes("FROM mailboxes") && sql.includes("IN (?")) {
          const rows = state.firstRows.get("internalMailboxes") ?? [];
          return { results: (Array.isArray(rows) ? rows : []) as T[] };
        }
        if (sql.includes("FROM attachment_uploads au")) {
          const rows = state.firstRows.get("attachmentUploads") ?? [];
          return { results: (Array.isArray(rows) ? rows : []) as T[] };
        }
        return { results: [] };
      };
      return runner as unknown as D1PreparedStatement;
    },
    async batch(statements: Array<{ sql?: string }>) {
      for (const stmt of statements) {
        state.batches.push({ sql: stmt.sql ?? "", params: [] });
      }
      return statements.map(() => ({
        success: true,
        meta: { changes: state.prepareResult.runChanges },
      }));
    },
  } as unknown as D1Database;
}

function buildKvStub(state: KvState): KVNamespace {
  return {
    get: async (key: string) => state.values.get(key) ?? null,
    put: async (key: string, value: string) => {
      state.values.set(key, value);
    },
  } as unknown as KVNamespace;
}

function buildScheduleTestFakes(): ScheduleTestFakes {
  const d1: D1State = {
    firstRows: new Map(),
    batches: [],
    idempotency: null,
    prepareResult: { first: null, runChanges: 1 },
  };
  const kv: KvState = { values: new Map() };
  const env = {
    DB: buildD1Stub(d1),
    KV: buildKvStub(kv),
  };
  const ctx = {
    principal,
    requestId: "request-1",
    env,
    modules: {
      env,
      mailboxes: {
        findAccess: async () => ({ role: "owner" }),
      },
    },
  } as never;
  return { d1, kv, ctx };
}

const baseArgs = {
  mailbox_id: "mailbox-1",
  to: ["recipient@example.com"],
  subject: "Later",
  text_body: "Body",
  scheduled_at: new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
  idempotency_key: "sched-key-1",
};

describe("schedule_message", () => {
  let fakes: ScheduleTestFakes;

  beforeEach(() => {
    fakes = buildScheduleTestFakes();
    fakes.d1.firstRows.set("mailbox", {
      id: "mailbox-1",
      domain_id: "domain-1",
      address: "owner@example.com",
      display_name: "Owner",
      outbound_connection_id: "conn-1",
      domain_status: "active",
      mailbox_status: "active",
    });
  });

  it("returns a preview + confirmation token without writing", async () => {
    const result = await scheduleMessageTool(fakes.ctx, { clock }).handler(
      baseArgs,
      { sessionId: null, requestId: "request-1" },
    );
    expect(result.structuredContent).toMatchObject({
      confirmation_required: true,
      preview: {
        mailbox_id: "mailbox-1",
        to: ["recipient@example.com"],
        subject: "Later",
        text_body: "Body",
      },
    });
    expect(result.structuredContent?.confirmation_token).toEqual(
      expect.any(String),
    );
    const outbound = fakes.d1.batches.find((b) =>
      b.sql.includes("INSERT INTO outbound_jobs"),
    );
    expect(outbound).toBeUndefined();
  });

  it("persists the message + outbound_jobs row after confirmation", async () => {
    const preview = await scheduleMessageTool(fakes.ctx, { clock }).handler(
      baseArgs,
      { sessionId: null, requestId: "request-1" },
    );
    const token = preview.structuredContent?.confirmation_token as string;
    const result = await scheduleMessageTool(fakes.ctx, { clock }).handler(
      { ...baseArgs, confirmation_token: token },
      { sessionId: null, requestId: "request-2" },
    );
    expect(result.structuredContent?.result).toMatchObject({
      jobId: expect.any(String),
      messageId: expect.any(String),
      scheduledAt: expect.any(String),
      replayed: false,
    });
    const outbound = fakes.d1.batches.find((b) =>
      b.sql.includes("INSERT INTO outbound_jobs"),
    );
    expect(outbound).toBeDefined();
    expect(outbound?.sql).toContain("created_via_schedule");
    expect(outbound?.sql).toContain("'pending'");
  });

  it("rejects too-soon scheduled_at with invalid_args", async () => {
    await expect(
      scheduleMessageTool(fakes.ctx, { clock }).handler(
        {
          ...baseArgs,
          scheduled_at: new Date(NOW.getTime() + 30 * 1000).toISOString(),
        },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toThrowError(McpToolError);
  });

  it("rejects too-late scheduled_at (>30d) with invalid_args", async () => {
    await expect(
      scheduleMessageTool(fakes.ctx, { clock }).handler(
        {
          ...baseArgs,
          scheduled_at: new Date(
            NOW.getTime() + 31 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toThrowError(McpToolError);
  });

  it("rejects malformed scheduled_at strings with invalid_args", async () => {
    await expect(
      scheduleMessageTool(fakes.ctx, { clock }).handler(
        { ...baseArgs, scheduled_at: "tomorrow" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toThrowError(McpToolError);
  });

  it("rejects when attachments reference missing uploads", async () => {
    const preview = await scheduleMessageTool(fakes.ctx, { clock }).handler(
      {
        ...baseArgs,
        attachments: ["missing-upload"],
      },
      { sessionId: null, requestId: "request-1" },
    );
    const token = preview.structuredContent?.confirmation_token as string;
    await expect(
      scheduleMessageTool(fakes.ctx, { clock }).handler(
        {
          ...baseArgs,
          attachments: ["missing-upload"],
          confirmation_token: token,
        },
        { sessionId: null, requestId: "request-2" },
      ),
    ).rejects.toThrowError(McpToolError);
  });

  it("denies principals without schedule.write (assertScope path)", async () => {
    const denied: Principal = {
      ...principal,
      permissions: new Set(["message.send"]),
    };
    const { assertScope } = await import("../../../../src/modules/mcp/auth");
    expect(() =>
      assertScope(denied, ["message.send", "schedule.write"]),
    ).toThrowError(McpToolError);
  });
});
