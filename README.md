# Unimailbox

Unimailbox is a multi-user, multi-domain mail system under development for
Cloudflare Workers. The repository contains setup, self-hosted identity,
tenancy, inbound, outbound, webhook, audit, mailbox and admin features.
The current implementation status and ordered work are in the
[integration plan](./docs/rebuild/12-cloud-mail-agentic-inbox-integration-plan.md).
Browser mail workflows and a real preview deployment remain unverified.

## Acceptance QA

- [完整验收测试用例](./docs/qa/acceptance-test-cases.md) — prerequisites, permissions, test steps,
  expected outcomes, preview evidence, known gaps, and release criteria.
- [验收执行记录 CSV](./docs/qa/acceptance-execution.csv) — matching cases with blank execution fields;
  all results start as not run.

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
pnpm dev:worker   # terminal 1: wrangler dev on apps/worker (http://localhost:8787)
pnpm dev:web      # terminal 2: vite dev on apps/web (http://localhost:5173)
```

The Vite server proxies `/api/*` to the local Worker, so use the Web URL during browser
development. Set `VITE_WORKER_URL` if the Worker is running on a different local port.

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

There is no active capability workspace. The current multi-user/multi-domain
direction, including admin-managed accounts, self-hosted authentication and the
shadcn-admin-kit UI base, is documented in
[`docs/rebuild/12-cloud-mail-agentic-inbox-integration-plan.md`](./docs/rebuild/12-cloud-mail-agentic-inbox-integration-plan.md).
The historical CAP-039–045 plan remains in the rebuild archive; current work
still needs a fresh preview deployment and a real browser/email closed loop.

- [`docs/rebuild/capability-ledger.md`](./docs/rebuild/capability-ledger.md) — authoritative status
- [`docs/rebuild/execution-plan.md`](./docs/rebuild/execution-plan.md) — ordered recovery plan
- [`docs/rebuild/11-agentic-inbox-adaptation.md`](./docs/rebuild/11-agentic-inbox-adaptation.md) — pinned reference patterns and adaptation boundaries
- [`docs/rebuild/13-shadcn-admin-kit-adoption.md`](./docs/rebuild/13-shadcn-admin-kit-adoption.md) — pinned UI base and migration boundary
- [`docs/rebuild/14-durable-object-mailbox-adr.md`](./docs/rebuild/14-durable-object-mailbox-adr.md) — V1 D1/R2/Queue decision and the future DO coordination boundary

## Deployment

Use the Node version in `.nvmrc`, pnpm from `packageManager`, and `pnpm wrangler` for the pinned workspace CLI. `pnpm deploy:staging --dry-run` runs release checks and prepares a fresh build; `pnpm deploy:staging` verifies and publishes the explicit staging config. Bootstrap and named secret rotation are separate commands. See [deployment and recovery runbook](docs/operations/deploy.md) for environment setup, release artifacts, monitoring and rollback.
