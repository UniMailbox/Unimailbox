# Unimailbox

Greenfield rebuild of the Unimailbox mail product on a Cloudflare Workers
stack. This repository is **CAP-001** — the monorepo scaffold + toolchain.
No business code has been written yet; subsequent capabilities in
[`docs/rebuild/08-roadmap/`](./docs/rebuild/08-roadmap/) lay the application on
top of this scaffold.

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

This README is intentionally minimal — the design spec is the source of
truth, not this file. See `docs/rebuild/capability-ledger.md` for the
authoritative execution state.