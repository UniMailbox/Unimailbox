# Unimailbox

Unimailbox is a multi-user, multi-domain mail system under development for
Cloudflare Workers. The repository contains setup, self-hosted identity,
tenancy, inbound, outbound, webhook, audit, mailbox and admin features.
Current status is recorded in the [capability ledger](./docs/rebuild/capability-ledger.md#current-state);
[design navigation](./docs/rebuild/README.md) distinguishes current decisions from historical plans.
The current implementation has been exercised on staging, including browser mail
workflows, scheduled delivery, cancellation-to-draft recovery and R2 attachment
downloads. See the [scheduled-send acceptance record](./docs/qa/scheduled-send-2026-10-09.md)
and the dated reports under `docs/qa/` for the observed behavior and remaining gaps.

## Acceptance QA

- [完整验收测试用例](./docs/qa/acceptance-test-cases.md) — prerequisites, permissions, test steps,
  expected outcomes, preview evidence, known gaps, and release criteria.
- [验收执行记录 CSV](./docs/qa/acceptance-execution.csv) — matching cases with blank execution fields;
  the comprehensive catalog has not been executed as a complete run. Dated focused
  QA records report the scenarios that have been exercised separately.

For the entry point for agents and the execution model, see
[`CLAUDE.md`](./CLAUDE.md).

## Quick start

```sh
nvm use                    # exact Node version from .nvmrc
pnpm install --frozen-lockfile
pnpm build
pnpm scaffold db:migrate    # apply + verify local D1; no Cloudflare account needed
```

Local development:

```sh
pnpm dev:worker   # terminal 1: wrangler dev on apps/worker (http://localhost:8787)
pnpm dev:web      # terminal 2: vite dev on apps/web (http://localhost:5173)
```

The local Worker uses `wrangler.dev.jsonc` with public development-only values.
These values are not staging credentials and must never be reused in a deployed
environment. Complete `/setup` in the browser to create the local administrator
and configure mail integrations. Real inbound/provider delivery requires a
configured Cloudflare environment; see the deployment runbook.

Run `pnpm verify` for the full local gate.

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

This repository's `main` now carries the rebuilt implementation. Completed editor
and scheduled-send task records are archived under `work/archive/2026-10/`.
The current multi-user/multi-domain direction includes admin-managed accounts,
self-hosted authentication, the [satnaing/shadcn-admin UI](./docs/rebuild/15-shadcn-admin-ui-redesign.md),
rich compose, hosted attachments, personal settings and English/Simplified Chinese.
The [integration plan](./docs/rebuild/12-cloud-mail-agentic-inbox-integration-plan.md)
and capability ledger retain the broader pending work; staging acceptance does
not imply production cutover or completion of the full acceptance catalog.

The previous repository implementation is retained in Git history and at
[`legacy/pre-rebuild-2026-10-10`](https://github.com/UniMailbox/Unimailbox/tree/legacy/pre-rebuild-2026-10-10).
The old and rebuilt applications have different migration histories; follow the
[environment deployment runbook](./docs/operations/deploy.md) for the selected
new environment rather than applying this schema to a legacy installation.

- [`docs/rebuild/capability-ledger.md`](./docs/rebuild/capability-ledger.md) — authoritative status
- [`docs/rebuild/execution-plan.md`](./docs/rebuild/execution-plan.md) — current priorities and historical recovery plan
- [`docs/rebuild/11-agentic-inbox-adaptation.md`](./docs/rebuild/11-agentic-inbox-adaptation.md) — pinned reference patterns and adaptation boundaries
- [`docs/rebuild/15-shadcn-admin-ui-redesign.md`](./docs/rebuild/15-shadcn-admin-ui-redesign.md) — current UI source and adaptation decisions
- [`docs/rebuild/14-durable-object-mailbox-adr.md`](./docs/rebuild/14-durable-object-mailbox-adr.md) — V1 D1/R2/Queue decision and the future DO coordination boundary

## Deployment

Use the Node version in `.nvmrc`, pnpm from `packageManager`, and `pnpm wrangler` for the pinned workspace CLI. `pnpm deploy:staging --dry-run` runs release checks and prepares a fresh build; `pnpm deploy:staging` verifies and publishes the explicit staging config. Bootstrap and named secret rotation are separate commands. See [deployment and recovery runbook](docs/operations/deploy.md) for environment setup, release artifacts, monitoring and rollback.

## Public repository hygiene

Keep real passwords, tokens, provider keys, private mail and download capabilities
out of Git and public documentation. Follow the [repository hygiene guide](./docs/operations/repository-hygiene.md)
for scan commands, fixture exceptions and commit preparation. Cloudflare resource
IDs and the public staging hostname are deployment metadata, not credentials.

## License

The repository retains its [GNU Affero General Public License v3](./LICENSE).
Imported UI components retain their upstream notices in
[`docs/rebuild/licenses/`](./docs/rebuild/licenses/).
