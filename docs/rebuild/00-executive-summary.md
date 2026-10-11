# Executive Summary — Cloud Mail Rebuild Specification

## What this document is

This is the **requirements + architecture specification** for a new repository that replaces the existing Cloud Mail system. The existing system lives at `cloud-mail/` and is treated as a **read-only reference**. The new system is built from scratch using the design captured here.

## What the existing system is

Cloud Mail is a **multi-tenant, invite-gated, serverless email service** built on Cloudflare Workers + D1 + R2 + KV. It supports:

- Personal and shared mailboxes under custom domains
- Inbound mail via Cloudflare Email Routing
- Outbound mail via Cloudflare Email binding, Resend, or Brevo
- A web admin + inbox client (legacy Vue + in-progress React)
- Operator-managed users, roles, registration keys, signatures, blacklist, AI code extraction, S3/R2 backends, and analytics

## Why rebuild

The existing system has crossed the threshold where the **accidental complexity exceeds the business complexity**. The most important problems:

- Single-round SHA-256 password hashing (no PBKDF2, no constant-time compare)
- SQL injection in `public-service.addUser`
- Plaintext API keys in the `setting` table
- A 311-line `email-service.send` function (three services in one)
- A 57-column `setting` god-object
- JSON blobs in text columns (`email.recipient`, `role.banEmail`, etc.)
- Two parallel sources of authorization truth
- Prefix-based route permission matching
- `pnpm test` actually runs `wrangler deploy`
- A `setting` table that owns blacklist policy, Telegram config, S3 credentials, R2/Resend/Brevo/CF provider config, Turnstile keys, signature, forwarding rules, login policy, AI policy, and notice copy — and is queried from every layer
- Two parallel web clients (Vue + React) with no shared contracts

The existing system works. It does not survive the next addition of: another provider, another transport protocol, real multi-tenancy, or another engineer.

## What we build instead

A **modular monolith** on the same Cloudflare runtime, in a new repo:

- Domain types own business rules. Providers own transport. Persistence owns D1. Workers' entrypoints are thin shells.
- One provider registry. One message lifecycle. One outbound job table. One authorization policy.
- A setup wizard that runs once on first install and yields a working tenant — no `setting` table to maintain by hand.
- One web client, built in the new repo with TanStack Query + Tiptap + shadcn/ui.
- TypeScript + Hono + Drizzle end-to-end, so contracts are explicit at every layer.

## Business ground truth

The core value loop is **four steps**, not the twenty-three operations the legacy UI exposes:

```
Operator installs → user invited → user signs in → user reads/writes mail → mail stored
```

The **six business capabilities** that account for ~95% of user value:

1. **Identity & tenancy** — operator + invited users with role-driven permissions
2. **Mailbox management** — own, share, rename, delete mailboxes
3. **Inbound mail** — receive, parse, store, notify
4. **Outbound mail** — compose, send through a provider, track delivery
5. **Attachments** — upload, inline, download, dedup, presigned URL
6. **Administration** — users, roles, registration keys, signatures, settings, audit

Everything else (Telegram forwarding, AI code extraction, ECharts analytics, S3 backend, public admin token, OAuth, Turnstile, S3 force-path-style) is **supporting infrastructure** that should not sit on the critical path.

## What this document set delivers

Ten artifacts (A–J) and a folder tree of supporting analyses under `docs/rebuild/`:

- **A. Executive Summary** — this file
- **B. Current Business Capability Map** — what the existing system does, with module → capability → side-effect mapping
- **C. Core Business Value Stream** — the one closed loop that defines success
- **D. Major Architectural Problems** — the smells that justify the rebuild
- **E. Proposed Domain Model** — bounded contexts, aggregates, state machines
- **F. Minimal Business Closed Loop** — the smallest end-to-end slice that proves the design
- **G. Target Architecture** — module boundaries, dependency rules, deploy model
- **H. Progressive Rebuild Roadmap** — Phases 0–6 with exit criteria
- **I. Legacy → New Mapping** — every legacy capability mapped to its new home (used as a *requirements* checklist in the new repo)
- **J. Risks & Open Questions** — what could break and what we still don't know

## Premise: greenfield

This rebuild happens in a **new repository**. We do not modify this folder's `mail-worker/`, `mail-vue/`, or `mail-react/`. We use them only as a reference. The new repo is built from `00-executive-summary.md` onward.

The only thing the new repo inherits from the existing system is **data**: a one-time migration script imports users, mailboxes, messages, attachments, and settings from the legacy D1 + R2 into the new schema. This migration is built in Phase 4 and runs per-deployment at cutover.

## Non-goals for the rebuild

To keep complexity honest:

- **Not** a generic email-as-a-service platform for external customers.
- **Not** a microservices decomposition. One Worker, multiple entrypoints.
- **Not** a UI redesign. The visual system in `DESIGN.md` of the existing repo is the design reference.
- **Not** a feature addition. Features that cannot be justified by cannot are deferred.
- **Not** a parallel run. The new system replaces the existing system when Phase 4 ships.
- **Not** a Vue or React-from-this-folder port. The new client is built fresh in the new repo.

## Decision principle

> Every new abstraction must answer "what concrete problem does this solve today?" If the answer is "future flexibility", we don't build it.

The roadmap is **vertical-slice, capability-by-capability**, not backend-then-frontend. Each Phase has explicit, observable exit criteria. We do not move to the next phase until the current one's tests, deploy, and smoke-test pass.