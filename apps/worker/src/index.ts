import * as Sentry from "@sentry/cloudflare";
import { handleHttpRequest } from "./entrypoints/http";
import { handleInboundEmail } from "./entrypoints/inbound-email";
import { handleQueueBatch } from "./entrypoints/queue";
import { handleScheduledTask } from "./entrypoints/scheduled";
import type { UniMailboxQueueJob, Env } from "./platform/config";
import { createWorkerSentryOptions } from "./platform/sentry";
import { MailboxAgent } from "./modules/agent/mailbox-agent-do";

const handler = {
  fetch: handleHttpRequest,
  email: handleInboundEmail,
  scheduled: handleScheduledTask,
  queue: handleQueueBatch,
} satisfies ExportedHandler<Env, UniMailboxQueueJob>;

export default Sentry.withSentry<Env, UniMailboxQueueJob>(
  (env: Env) => createWorkerSentryOptions(env),
  handler,
);

export { MailboxAgent };
