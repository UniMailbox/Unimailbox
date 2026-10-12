# Unimailbox repository and runtime map

## Repository layout

```text
apps/
  worker/              HTTP API, email, queue and scheduled Worker handlers
  web/                 React/Vite/TanStack Router client
packages/
  contracts/           Shared request schemas, response types and permissions
  email-core/          MIME parsing and pure email behavior
  config/              Shared configuration types
  test-kit/            Local runtime fixtures and migration helpers
migrations/            Ordered D1 migrations and verification companions
scripts/               Structural checks, bootstrap, release and operations CLI
docs/operations/       Installation and operating guides
docs/rebuild/          Design decisions and delivery history
docs/qa/               Acceptance catalog and dated verification records
```

## Runtime entrypoints

[`apps/worker/src/worker.ts`](../../../apps/worker/src/worker.ts) exposes the
HTTP, email, Queue and scheduled behavior. Hono routes live under
`apps/worker/src/http/`; `app-context.ts` composes module collaborators.
The frontend and API are served on the same deployment origin through Worker
Assets. Modules own their use cases and repositories; shared contracts live in
`packages/contracts`.

## Resource topology

| Binding | Purpose |
| --- | --- |
| `DB` | D1 identity, mailbox, message, job, configuration and audit records |
| `ATTACHMENTS` | R2 raw mail and attachment/editor bytes |
| `SETUP_SESSION` | KV short-lived setup sessions |
| `CACHE` | KV bounded operational/cache state |
| `OUTBOUND` | Outbound Queue producer/consumer |
| `OUTBOUND_DLQ` | Dead-letter Queue and metrics |
| `ASSETS` | Built frontend |
| `VERSION` | Published Worker version metadata |
| `INSTALLATION_TOKEN` | Protected installation claim token |
| `CREDENTIAL_ENCRYPTION_KEY` | Provider-credential AES-GCM key |
| `CURSOR_SIGNING_KEY` | Inbox cursor signing key |
| `AI` | Template Workers AI binding; application AI features are optional |

Environment configs declare the resources. New installations start from the
production or preview example and provision independent data and secrets.
Local development uses simulated bindings and private `.dev.vars`; test config
contains synthetic fixtures. Neither is a release target.

## Validation and deployment

`pnpm verify` owns the implementation gate. `pnpm scaffold bootstrap` provisions
missing resources; `pnpm scaffold deploy` verifies, migrates, publishes and
checks an explicit environment. `pnpm ops:check` checks dependency and maintenance
health. Read the [agent deployment guide](../../operations/agent-deploy.md) for
prerequisites and service acceptance, and the
[release runbook](../../operations/deploy.md) for upgrades and recovery.

Current delivery status lives in the
[capability ledger](../capability-ledger.md#current-state). Adjacent historical
dependency/module analyses are not a description of today's deployment topology.
