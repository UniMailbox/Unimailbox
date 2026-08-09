import * as Sentry from "@sentry/cloudflare";
import { handleHttpRequest } from "./entrypoints/http";
import { handleInboundEmail } from "./entrypoints/inbound-email";
import { handleQueueBatch } from "./entrypoints/queue";
import type { UniMailboxQueueJob, Env } from "./platform/config";
import { createWorkerSentryOptions } from "./platform/sentry";

// M1 entrypoint set (issue #20). The cron triggers declared in
// wrangler.jsonc remain for backwards compatibility, but no cron
// handler is wired here — `entrypoints/scheduled.ts` is a no-op stub
// that M2's cleanup backlog (issue #28) and the time-based send flow
// (issue #29) can revive without touching this registration.
//
// The deferred modules referenced here (orphan sweep, idempotency
// purges, time-based send dispatch) keep their table writes through
// `0010_mvp_minimum.sql` and friends, so the missing cron wiring is
// safe — see issue #20's behavioural requirement.
const handler = {
  fetch: handleHttpRequest,
  email: handleInboundEmail,
  queue: handleQueueBatch,
} satisfies ExportedHandler<Env, UniMailboxQueueJob>;

export default Sentry.withSentry<Env, UniMailboxQueueJob>(
  (env: Env) => createWorkerSentryOptions(env),
  handler,
);