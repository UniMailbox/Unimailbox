# Unimailbox

Greenfield rebuild of the Unimailbox mail product on a Cloudflare Workers
stack. The repository now contains setup, identity, tenancy, inbound,
outbound, webhook, audit, and reliability backend slices through the active
Phase 2 work. The browser application and deployable delivery path are still
being recovered; do not infer product readiness from green local tests.

For the entry point for agents and the execution model, see
[`CLAUDE.md`](./CLAUDE.md).

## Quick start

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm build
```

Local development:

```sh
pnpm dev:worker   # wrangler dev on apps/worker
pnpm dev:web      # vite dev on apps/web
```

## Repository layout

```
apps/
  worker/           Hono app on Cloudflare Workers
  web/              React + Vite + TanStack Router client
packages/
  contracts/        Shared zod schemas + TS types
  email-core/       Pure RFC 5322 functions
  config/           Shared config types
  test-kit/         Test fixtures + helpers
migrations/         D1 SQL migrations (CAP-004)
scripts/            CLI scripts (CAP-003)
docs/rebuild/       Design specification
```

## Status

Current work is CAP-030 (lifecycle direction guards). Local quality gates are
green, but Phase 0 and Phase 1 delivery verification are reopened because the
setup/client routes, static asset integration, queue consumer configuration,
repeat-safe remote migrations, and preview business loop are not yet complete.

- [`docs/rebuild/capability-ledger.md`](./docs/rebuild/capability-ledger.md) — authoritative status
- [`docs/rebuild/execution-plan.md`](./docs/rebuild/execution-plan.md) — ordered recovery plan
- [`docs/rebuild/11-agentic-inbox-adaptation.md`](./docs/rebuild/11-agentic-inbox-adaptation.md) — pinned reference patterns and adaptation boundaries
