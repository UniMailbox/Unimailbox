// Worker composition module — the single entry module Cloudflare deploys.
// Default-exports one object with `fetch`, `email`, `queue`, and `scheduled`
// handlers. Each handler lives in its own file under `entrypoints/`.
//
// Per .claude/rules/architecture.md §Shape — "One Worker, multiple entrypoints."
// Setting this file as `wrangler.jsonc:main` wires every Cloudflare trigger
// to the right handler.
import { app } from './entrypoints/http';
import inboundEmail from './entrypoints/inbound-email';
import queue from './entrypoints/queue';
import scheduled from './entrypoints/scheduled';
import type { Env } from './platform/env';

export default {
  fetch: app.fetch,
  email: inboundEmail.email,
  queue: queue.queue,
  scheduled: scheduled.scheduled,
} satisfies ExportedHandler<Env>;
