# Unimailbox

Greenfield rebuild of the Unimailbox mail product on a Cloudflare Workers
stack. The repository contains setup, identity, tenancy, inbound, outbound,
webhook, audit, and reliability backend slices through CAP-040, plus the
CAP-041 setup wizard. The remaining browser workflows and preview deployment
evidence are still pending; do not infer product readiness from green local tests.

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

There is no active capability workspace. CAP-042 (auth/session and the
authorized mailbox shell) is next. CAP-039–041 implemented the local delivery
substrate, webhook/audit hardening, and setup wizard. Phase 0 and Phase 1 remain
reopened until CAP-042–045 complete the browser workflows and demonstrate a
fresh and repeat preview deployment with the real business loop.

- [`docs/rebuild/capability-ledger.md`](./docs/rebuild/capability-ledger.md) — authoritative status
- [`docs/rebuild/execution-plan.md`](./docs/rebuild/execution-plan.md) — ordered recovery plan
- [`docs/rebuild/11-agentic-inbox-adaptation.md`](./docs/rebuild/11-agentic-inbox-adaptation.md) — pinned reference patterns and adaptation boundaries
