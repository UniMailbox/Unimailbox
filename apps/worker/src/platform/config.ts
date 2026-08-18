import { RuntimeConfigSchema, type RuntimeConfig } from "@unimailbox/config";

export interface SecretStoreBinding {
  get(): Promise<string>;
}

export type SecretBinding = string | SecretStoreBinding;

export interface WorkerVersionMetadataBinding {
  id: string;
  tag?: string;
  timestamp: string;
}

export interface OutboundMailJob {
  kind?: "outbound";
  jobId: string;
  messageId: string;
}

export interface OrphanObjectCleanupJob {
  kind: "orphan_object_cleanup";
  jobId: string;
  objectKeys: string[];
}

export type UniMailboxQueueJob = OutboundMailJob | OrphanObjectCleanupJob;

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  /**
   * Optional R2 binding. When present, raw messages and attachment bytes are
   * stored in R2; otherwise the KV-backed default backend is used. The runtime
   * picks the backend automatically based on binding presence — see
   * `apps/worker/src/platform/attachment-store.ts`.
   */
  ATTACHMENTS?: R2Bucket;
  OUTBOUND_QUEUE: Queue<UniMailboxQueueJob>;
  ASSETS: Fetcher;
  AUTH_SIGNING_KEY: SecretBinding;
  CREDENTIAL_ENCRYPTION_KEY: SecretBinding;
  CLOUDFLARE_OAUTH_CLIENT_ID?: SecretBinding;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: SecretBinding;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadataBinding;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_SAMPLE_RATE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  /**
   * First-party MCP server bindings (stage 0 foundation — entrypoint not yet
   * wired up; later PRs add `apps/worker/src/entrypoints/mcp.ts`).
   *
   * Marked optional in the foundation stage so existing test fixtures and
   * applications that do not yet touch the MCP surface do not have to stub
   * every binding. The `wrangler.jsonc` declares all of them, so at runtime
   * `AI`, `VECTORIZE`, `INBOX_INDEX_QUEUE`, and `MAILBOX_AGENT` are guaranteed
   * to be present once `wrangler deploy` runs against this config.
   *
   * `AI_GATEWAY` is the exception: the wrangler 4.114 schema does not yet
   * recognise the `ai_gateway` field (see wrangler.jsonc comment), so the
   * binding is forward-declared and stays undefined at runtime until
   * wrangler is upgraded to >= 4.115. Stage 2 (PR #6) consumes it with a
   * graceful fallback when absent.
   *
   * Later PRs that wire the entrypoint should promote `AI`, `VECTORIZE`,
   * `INBOX_INDEX_QUEUE`, and `MAILBOX_AGENT` to required.
   */
  AI?: Ai;
  AI_GATEWAY?: { run: Ai["run"]; getUrl?: () => string };
  VECTORIZE?: VectorizeIndex;
  INBOX_INDEX_QUEUE?: Queue<{ mailbox_id: string; message_id: string }>;
  MAILBOX_AGENT?: DurableObjectNamespace;
}

export async function readSecretBinding(
  binding: SecretBinding,
): Promise<string> {
  return typeof binding === "string" ? binding : binding.get();
}

export async function resolveRuntimeConfig(env: Env): Promise<RuntimeConfig> {
  return RuntimeConfigSchema.parse({
    AUTH_SIGNING_KEY: await readSecretBinding(env.AUTH_SIGNING_KEY),
    CREDENTIAL_ENCRYPTION_KEY: await readSecretBinding(
      env.CREDENTIAL_ENCRYPTION_KEY,
    ),
    ALLOWED_ORIGINS: [],
  });
}
