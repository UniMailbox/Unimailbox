# Agentic Inbox Reference and Adaptation Guide

This document defines how Unimailbox uses Cloudflare's
[`agentic-inbox`](https://github.com/cloudflare/agentic-inbox) as a reference implementation.
It is a pattern source, not a product specification and not a codebase to copy wholesale.

## Pinned reference

| Field | Value |
|---|---|
| Repository | `https://github.com/cloudflare/agentic-inbox` |
| Branch inspected | `main` |
| Commit inspected | `48039bb6785af34e592c2966f87cde2b255c4c80` |
| Inspected on | 2026-08-19 |
| License | Apache-2.0 |

Every capability that relies on this reference records the commit and the specific upstream files
in its `task.md`. A future upstream commit is not adopted implicitly; update this document after a
new comparison.

## What the reference proves

The pinned code demonstrates a working Cloudflare-native product shape:

- `workers/app.ts` mounts the Hono API before a React Router catch-all and exports the email
  handler from the same Worker entry module.
- `vite.config.ts`, `react-router.config.ts`, and `package.json` build the UI and Worker as one
  deployment unit rather than guessing a generated asset filename in an HTML string.
- `workers/index.ts` accepts inbound Email Routing events, persists the message, and rethrows
  processing failures so delivery is not silently acknowledged.
- `wrangler.jsonc` declares the runtime bindings used by the implementation: Email Sending, R2,
  Durable Objects, Workers AI, and observability.
- `app/services/api.ts`, `app/queries/keys.ts`, and `app/queries/emails.ts` separate HTTP transport,
  stable query keys, query hooks, mutation invalidation, and rollback-aware optimistic updates.
- `app/routes.ts` and `app/routes/mailbox.tsx` use nested mailbox routes and a persistent shell for
  navigation, list/detail content, composition, and responsive panels.
- `workers/lib/attachments.ts` centralizes R2 key construction, filename sanitization, byte
  conversion, and attachment metadata.

These are implementation patterns. Unimailbox acceptance still comes from its business rules,
ADRs, capability contracts, security rules, and preview-deployment evidence.

## Adopt, adapt, reject

| Upstream pattern | Decision | Unimailbox adaptation |
|---|---|---|
| One Cloudflare Worker owns API, UI fallback, and email entrypoint | Adopt | Keep the existing single Worker with `fetch`, `email`, `queue`, and `scheduled`; wire the Vite build through a supported asset/SSR integration instead of hard-coding `/assets/index.js`. |
| API routes are mounted before the UI catch-all | Adopt | Preserve `/api/v1/*` error semantics and make every non-API client route, including `/setup`, resolve to the web application. |
| Typed API service plus TanStack Query key factories/hooks | Adapt | Generate or derive request/response types from `packages/contracts`; add auth/session and `Idempotency-Key` handling; use cursor metadata rather than page numbers. |
| Query mutations invalidate related list/detail/folder data | Adapt | Use rollback-aware optimistic updates only where authorization and server state remain authoritative. Never use a UI store as an event bus. |
| Rich composer, reply/forward, thread and attachment UI | Adapt | Reuse interaction patterns, but implement the lifecycle, idempotency, outbox, draft concurrency, attachment upload, and authorization rules defined by Unimailbox. |
| R2 attachment helper | Adapt | Keep sanitized opaque keys, but require upload ownership, size/expiry checks, atomic consumption, and authorized download from Phase 3. |
| Email handler rethrows processing failures | Adopt | Preserve retry semantics and structured redacted logging; do not acknowledge an inbound message before the durable write succeeds. |
| Cloudflare Email Sending binding | Defer | Add as a provider adapter in Phase 5; Brevo remains the current provider. No business use case may branch on provider. |
| One Durable Object with SQLite per mailbox | Reject for current architecture | Unimailbox uses D1, durable outbox records, explicit module ownership, and per-user mailbox authorization. Changing persistence topology requires an ADR and migration plan. |
| Cloudflare Access grants every admitted teammate access to every mailbox | Reject | Unimailbox keeps its own authn, DB-backed permissions, mailbox roles, IDOR protection, and per-request authorization checks. |
| Mailbox metadata stored as JSON in R2 | Reject | Identity, tenancy, settings, and audit metadata remain typed D1 data. R2 stores attachment bytes, not authorization truth. |
| Send is persisted as `sent` before deferred delivery completes | Reject | Unimailbox keeps `queued -> sending -> sent/failed` plus durable outbox, retry classification, idempotency, and recovery. |
| AI agent and MCP surfaces | Defer | Phase 5 only, opt-in, after the core mail loop is verified and authorization/audit boundaries are specified. |

## Capability-level reference workflow

Before implementation, the capability contract must answer:

1. Which pinned upstream files were inspected?
2. What behavior or boundary is being adopted?
3. What must change for Unimailbox business rules, authz, data ownership, idempotency, and audit?
4. What upstream behavior is explicitly rejected?
5. Does any copied or closely adapted code retain the required Apache-2.0 notice?

Reviewers verify the resulting behavior against Unimailbox rules, not against visual similarity to
the reference. “Agentic Inbox does it this way” is evidence that a Cloudflare integration pattern
is viable; it is never sufficient evidence that the pattern is correct for this product.

## Planned use by recovery capability

| Capability | Upstream files to consult | Intended use |
|---|---|---|
| CAP-039 | `workers/app.ts`, `vite.config.ts`, `react-router.config.ts`, `wrangler.jsonc` | Worker/UI build integration, API-before-client fallback, complete runtime bindings |
| CAP-041–CAP-044 | `app/routes.ts`, `app/routes/*`, `app/services/api.ts`, `app/queries/*`, `app/components/*` | Nested mailbox UI, explicit loading/empty/error/success states, typed query/mutation organization |
| CAP-043 | `app/routes/email-list.tsx`, `app/components/EmailPanel*`, `app/queries/emails.ts` | Inbox/detail/thread/read-state behavior without copying upstream authorization or pagination assumptions |
| CAP-044 | `app/components/ComposeEmail.tsx`, `app/hooks/useComposeForm.ts`, `app/components/RichTextEditor.tsx` | Compose/reply interaction and mutation lifecycle adapted to durable outbox and idempotency |
| Phase 3 attachments | `workers/lib/attachments.ts`, `app/components/EmailAttachmentList.tsx` | R2 naming/sanitization and attachment presentation adapted to presigned upload ownership rules |
| Phase 5 provider | `workers/email-sender.ts`, `wrangler.jsonc` | Cloudflare Email Sending adapter behind the existing provider registry |

