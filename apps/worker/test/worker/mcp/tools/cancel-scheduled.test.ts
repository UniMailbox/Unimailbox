import { beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { McpToolError } from "../../../../src/modules/mcp/errors";
import { cancelScheduledTool } from "../../../../src/modules/mcp/tools/schedule-tools";

/**
 * `cancel_scheduled` is the user's own revoke. It does NOT require
 * `message.send` — only `schedule.write` — so the test fixture grants
 * just that one scope.
 */
const principal: Principal = {
  userId: "user-1",
  email: "owner@example.com",
  permissions: new Set(["schedule.write"]),
};

interface D1State {
  jobLookup: {
    id: string;
    message_id: string;
    created_by_user_id: string;
  } | null;
  deleteChanges: number;
  postDeleteStatus: string | null;
  calls: Array<{ sql: string }>;
  // Tracks the most recent idempotency record so a re-call with the
  // same key replays the cached response instead of running again.
  idempotency: {
    key: string;
    request_hash: string;
    body: string;
  } | null;
}

function freshD1(): D1State {
  return {
    jobLookup: {
      id: "job-1",
      message_id: "msg-1",
      created_by_user_id: principal.userId,
    },
    deleteChanges: 1,
    postDeleteStatus: null,
    calls: [],
    idempotency: null,
  };
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
          state.calls.push({ sql });
          if (
            sql.includes("FROM outbound_jobs oj") &&
            sql.includes("JOIN messages m")
          ) {
            return (state.jobLookup ?? null) as T | null;
          }
          if (sql.includes("SELECT status FROM outbound_jobs WHERE id =")) {
            return (
              state.postDeleteStatus === null
                ? null
                : { status: state.postDeleteStatus }
            ) as T | null;
          }
          if (
            sql.includes("FROM idempotency_records") &&
            sql.includes("operation = ?")
          ) {
            // SELECT binds: principal.userId (0), operation (1), key (2).
            const key = String(bound[2] ?? "");
            if (state.idempotency && state.idempotency.key === key) {
              // Hash mismatch surfaces as `idempotency_conflict` in
              // production; mirror that here so the test exercises the
              // right branch.
              if (
                state.idempotency.request_hash !==
                state.idempotency.request_hash
              ) {
                return { request_hash: "different", response_json: "{}" } as T;
              }
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
          return null;
        },
        async run(): Promise<{ success: boolean; meta: { changes: number } }> {
          state.calls.push({ sql });
          if (sql.startsWith("DELETE FROM outbound_jobs")) {
            return {
              success: true,
              meta: { changes: state.deleteChanges },
            };
          }
          if (sql.startsWith("INSERT INTO idempotency_records")) {
            // INSERT binds: uuid (0), principal.userId (1), operation (2),
            // key (3), hash (4), status (5), body JSON (6).
            const responseBody = String(bound[6] ?? "{}");
            const parsed = JSON.parse(responseBody) as { body: string };
            state.idempotency = {
              key: String(bound[3] ?? ""),
              request_hash: String(bound[4] ?? ""),
              body: parsed.body,
            };
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
        async batch(statements: Array<{ sql?: string }>) {
          for (const stmt of statements) {
            state.calls.push({ sql: stmt.sql ?? "" });
          }
          return statements.map(() => ({
            success: true,
            meta: { changes: 1 },
          }));
        },
      };
      return runner;
    },
  } as unknown as D1Database;
}

function kvStub(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
  } as unknown as KVNamespace;
}

function buildCtx(state: D1State) {
  const env = { DB: buildD1Stub(state), KV: kvStub() };
  return {
    principal,
    requestId: "request-1",
    env,
    modules: { env },
  } as never;
}

describe("cancel_scheduled", () => {
  let state: D1State;
  beforeEach(() => {
    state = freshD1();
  });

  it("cancels an existing pending job and returns the cancelled status", async () => {
    const result = await cancelScheduledTool(buildCtx(state)).handler(
      { job_id: "job-1", idempotency_key: "cancel-1" },
      { sessionId: null, requestId: "request-1" },
    );
    expect(result.structuredContent).toMatchObject({
      job_id: "job-1",
      status: "cancelled",
      replayed: false,
    });
  });

  it("is idempotent — re-cancelling returns the same payload via replay", async () => {
    const ctx = buildCtx(state);
    const first = await cancelScheduledTool(ctx).handler(
      { job_id: "job-1", idempotency_key: "cancel-idem" },
      { sessionId: null, requestId: "request-1" },
    );
    expect(first.structuredContent).toMatchObject({ status: "cancelled" });
    const second = await cancelScheduledTool(ctx).handler(
      { job_id: "job-1", idempotency_key: "cancel-idem" },
      { sessionId: null, requestId: "request-2" },
    );
    expect(second.structuredContent).toMatchObject({
      status: "cancelled",
      replayed: true,
    });
  });

  it("reports the new status when the dispatcher already promoted the row", async () => {
    state.deleteChanges = 0;
    state.postDeleteStatus = "processing";
    const result = await cancelScheduledTool(buildCtx(state)).handler(
      { job_id: "job-1", idempotency_key: "cancel-late" },
      { sessionId: null, requestId: "request-1" },
    );
    expect(result.structuredContent).toMatchObject({
      job_id: "job-1",
      status: "processing",
      replayed: false,
    });
  });

  it("rejects unknown jobs with not_found", async () => {
    state.jobLookup = null;
    await expect(
      cancelScheduledTool(buildCtx(state)).handler(
        { job_id: "missing", idempotency_key: "cancel-missing" },
        { sessionId: null, requestId: "request-1" },
      ),
    ).rejects.toThrowError(McpToolError);
  });

  it("denies principals without schedule.write via assertScope", async () => {
    const denied: Principal = {
      ...principal,
      permissions: new Set(["message.send"]),
    };
    const { assertScope } = await import("../../../../src/modules/mcp/auth");
    expect(() => assertScope(denied, ["schedule.write"])).toThrowError(
      McpToolError,
    );
  });
});
