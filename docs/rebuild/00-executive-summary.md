# Executive Summary — Unimailbox

Unimailbox is an open-source mail application operated through an independent
Cloudflare installation. Each operator owns the account, domains, resources and
credentials. An installation can serve multiple users, domains and mailboxes.

## Current product

The current application provides administrator-managed accounts and mailbox
access, incoming mail through Cloudflare Email Routing, outgoing mail through
Brevo, rich compose, drafts, replies, scheduled sending, R2 attachments, personal
settings, audit logs and a bilingual web client. AI assistance is optional.

The implementation is a TypeScript modular monolith: Hono handles the API,
Drizzle accesses D1, and React/Vite/TanStack Router serve the web client. Worker
entrypoints handle HTTP, incoming email, outbound Queue jobs and scheduled
maintenance. Provider adapters keep external services separate from mail rules.

Login identity and mailbox access are separate. Global permissions and explicit
mailbox ownership/membership both govern mail operations. Provider credentials
are encrypted in D1 using a key held in Secrets Store; private mail bytes live
in R2. Durable outbound jobs and audited state changes support retry and recovery.

## Installation and acceptance

Start with the [agent deployment guide](../operations/agent-deploy.md). It covers
required inputs, resource creation, publication, administrator setup, routing,
provider configuration, optional settings and real mail acceptance. The current
runtime is Cloudflare; the repository does not ship a standalone VPS mail server.

The usable-service loop is:

```text
Operator deploys and configures mail
  → administrator creates users, mailboxes and access grants
  → user signs in and reads incoming mail
  → user sends and replies through the provider
  → messages and attachments remain accessible under the correct permissions
```

A published Worker or completed wizard does not establish external delivery.
A new installation needs its own verified incoming, outgoing, reply and attachment
checks. Historical tests and maintainer deployment records describe their own
scope only.

## Documentation authority

- [Capability ledger](capability-ledger.md#current-state): current delivered behavior and remaining gaps.
- [Business rules](02-business-discovery/business-rules.md): accepted invariants.
- [Architecture](05-target-architecture/architecture.md): runtime and module boundaries.
- [Implementation plan](12-mail-system-implementation-plan.md): direction and dated plans.
- [Release runbook](../operations/deploy.md): upgrades, secrets and recovery.
- [Acceptance catalog](../qa/acceptance-test-cases.md): broader test coverage.

Earlier discovery, phase and legacy-review documents are design history. They do
not enable transports, providers or authentication modes that the current source
and deployment guide do not support. Existing-system data import is separate
work; never apply this application's migrations to an incompatible database.
