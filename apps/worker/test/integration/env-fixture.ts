import { env } from "cloudflare:test";
import {
  createAttachmentStore,
  detectStorageBackend,
  type AttachmentStore,
} from "../../src/platform/attachment-store";
import type { Env } from "../../src/platform/config";

const VECTOR_DIMENSION = 768;
const VECTOR_FILL_VALUE = 0.1;

/**
 * Deterministic Workers AI mock: returns a 768-dim vector filled with
 * 0.1 for embedding-style models and a canned JSON object for the rest.
 * Keeping the embed output stable lets semantic-search fixtures assert on
 * specific Vectorize ids without flakiness.
 *
 * Cast through `unknown` because Workers AI's `Ai.run` overloads are
 * intentionally narrow per model; tests assert behaviour, not types.
 */
const aiMockRun = (async (
  _model: string,
  _inputs: unknown,
): Promise<unknown> => {
  if (
    typeof _model === "string" &&
    (_model.includes("bge") || _model.includes("embed"))
  ) {
    return { data: [new Array(VECTOR_DIMENSION).fill(VECTOR_FILL_VALUE)] };
  }
  return {
    response: '{"summary":"mock summary","labels":["work"],"action_items":[]}',
  };
}) as unknown as Ai["run"];

/**
 * Build an Env for integration tests. By default we re-use the worker test
 * pool's bindings (which provide both KV and R2). Pass `withoutR2: true` to
 * simulate the default production deployment that omits R2 — the attachment
 * store will then pick the KV backend.
 *
 * The MCP foundation bindings (AI / VECTORIZE / AI_GATEWAY / INBOX_INDEX_QUEUE
 * / MAILBOX_AGENT) are stubbed locally so existing tests do not require the
 * real Wrangler bindings to be present in the test pool. Stage 1 will layer
 * real assertions on top of these mocks.
 */
export function makeEnv(options: { withoutR2?: boolean } = {}): Env {
  const envRecord = env as unknown as Record<string, unknown>;
  const base: Env = {
    DB: env.DB,
    KV: env.KV,
    OUTBOUND_QUEUE: env.OUTBOUND_QUEUE,
    ASSETS: {} as Fetcher,
    AUTH_SIGNING_KEY: "x".repeat(32),
    CREDENTIAL_ENCRYPTION_KEY: "e".repeat(32),
    CF_VERSION_METADATA: {
      id: "integration-version",
      tag: "integration",
      timestamp: "2026-08-02T00:00:00.000Z",
    },
    AI: { run: aiMockRun } as unknown as Ai,
    VECTORIZE: {
      upsert: async () => ({ mutationId: "mock", ids: [] }),
      query: async () => ({ matches: [], count: 0 }),
      insert: async () => ({ mutationId: "mock", ids: [] }),
      delete: async () => ({ mutationId: "mock", ids: [] }),
      getByIds: async () => [],
      describe: async () => ({
        name: "unimailbox-messages",
        description: "mock",
        config: { dimensions: VECTOR_DIMENSION, metric: "cosine" },
        createdOn: new Date(0).toISOString(),
        vectorsCount: 0,
      }),
    } as unknown as VectorizeIndex,
    AI_GATEWAY: {
      run: aiMockRun,
      getUrl: () => "mock://gateway",
    },
    INBOX_INDEX_QUEUE: {
      send: async () => undefined,
      sendBatch: async () => undefined,
    } as unknown as Queue<{ mailbox_id: string; message_id: string }>,
    MAILBOX_AGENT: {
      idFromName: (name: string) => envRecord.MAILBOX_AGENT_NS ?? name,
      newUniqueId: () => "mock-id",
      get: () => ({
        fetch: async () => new Response("mock-do", { status: 200 }),
      }),
    } as unknown as DurableObjectNamespace,
  };
  if (!options.withoutR2 && envRecord.ATTACHMENTS) {
    base.ATTACHMENTS = envRecord.ATTACHMENTS as R2Bucket;
  }
  return base;
}

export function makeAttachmentStore(
  options: { withoutR2?: boolean } = {},
): AttachmentStore {
  return createAttachmentStore(makeEnv(options));
}

export function makeStorageBackend() {
  return detectStorageBackend(makeEnv()).backend;
}
