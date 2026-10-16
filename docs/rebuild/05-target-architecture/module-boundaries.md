# Module boundaries

This is the current module boundary policy. `apps/worker/src/app-context.ts`
wires dependencies with `buildAppContext(env)`; HTTP, email, Queue and scheduled
entrypoints use that composition. Modules expose public functions and types via
`index.ts`; the initial class-based `application/domain/infrastructure` layout
was a design sketch, not a required directory structure.

## Dependency table

Every module may use platform helpers and shared contracts. The table lists
additional permitted dependencies; a permitted edge need not be used today.

| Module | Additional dependencies |
| --- | --- |
| identity | None |
| onboarding | identity, tenancy, admin, outbound-mail (setup orchestration) |
| tenancy | identity |
| messages | tenancy |
| inbound-mail | tenancy, messages, email-core; admin read contracts wired through AppContext |
| outbound-mail | tenancy, messages, editor-assets, signatures, provider integrations, email-core; audit writer contract |
| provider-sync | messages, provider integrations |
| attachments | messages, tenancy |
| editor-assets | None |
| signatures | tenancy, editor-assets |
| admin | identity, tenancy, messages, outbound-mail |
| ai | None; configuration loader and AI adapter contracts wired by app-context |
| installation | identity, tenancy, admin |
| maintenance | messages, tenancy, attachments |

No cycles. Inbound policy readers and outbound audit writers are contracts,
implemented by admin and wired at the composition root; these do not permit
direct `modules/admin/*` imports. Admin's outbound connection management is a
public outbound-mail dependency, so the reverse direct import is forbidden.

## Public surface and transport

- Routes and other modules import `modules/<name>` through its public index,
  never another module's private file or a hypothetical `application/*` path.
- A route handles transport validation, authentication and permission checks.
  The use case enforces mailbox ownership and business state, then batches
  related persistence, idempotency and audit writes.
- Shared API schemas and integration seams come from `packages/contracts`.
  Do not expose Drizzle row types as cross-module domain contracts.
- Provider adapters implement the neutral registry interfaces. Provider SDKs
  belong in integrations; integration code never imports application modules.

The current ESLint rules enforce major layer directions and Hono restrictions.
The full pairwise dependency policy also requires code review.

## Persistence authority

| Area | Authority |
| --- | --- |
| Users, sessions and personal preferences | identity, D1; private avatar bytes in R2 |
| Installation lifecycle and setup | onboarding/installation orchestration, D1 + short-lived setup KV |
| Domains, mailboxes, members | tenancy, D1 |
| Messages, recipients, mailbox views, user state, drafts and inbound receipts | messages, D1 |
| Attachment uploads and downloads | attachments with message metadata in D1 and bytes in R2 |
| Editor assets and durable usages | editor-assets, D1 + R2 |
| Domain signatures | signatures, D1, with editor-asset usage references |
| Jobs, submission attempts, provider connections, encrypted credentials and webhook state | outbound-mail, D1 |
| Roles, permissions, settings, audit, blocklists and role policies | admin, D1 |
| MCP service/prompt configuration, personal credentials, scopes and rate windows | admin, D1; personal transport derives the credential owner from the session |
| AI configuration and encrypted AI credentials | admin, D1; AI adapters and service wired by app-context |
| Idempotency infrastructure | platform helpers; business modules batch their records with writes |

Resource cleanup goes through these ownership boundaries. Published editor
usages protect historical mail; private incoming attachments retain mailbox
authorization. See [editor storage](../16-email-editor-storage.md) and
[storage decision](../14-durable-object-mailbox-adr.md).

AI service details and configuration semantics: [AI service foundation](../18-ai-service-foundation.md).

Administrator resource usage uses a neutral reader wired in app-context to the
Cloudflare Analytics integration. It reads only explicitly configured platform
resources, without private-mail joins or telemetry persistence. See
[resource usage](../22-resource-usage-dashboard.md).

The separate Admin mail-processing read model aggregates existing messages,
attachment/hosted-usage, outbox and receipt metadata. It performs no business
writes and exposes no bodies, addresses, identifiers or file keys. Creation-date
cohorts and relation lookups are indexed and bounded; the design above owns
retention, current-state and latency interpretation.

Inbound policy remains synchronous; accepted-message finalization and recovery
are orchestrated by inbound-mail using messages-owned receipt/metadata APIs.
The existing mail-work Queue retains its `OUTBOUND` binding and handles versioned
inbound recovery envelopes alongside legacy outbound jobs. See
[inbound recovery](../20-inbound-recovery.md) for acceptance and storage boundaries.

Outbound-mail owns the durable submission journal and reconciliation use cases.
Provider adapters return only positive acceptance evidence or explicitly classify
nonacceptance versus unknown outcomes. See [submission outcomes](../21-outbound-submission-outcomes.md).

Email AI reply orchestration belongs to messages. Its AI service and audit writer
are neutral contracts supplied by HTTP composition, without dependencies on the
AI/admin modules or SDKs. The use case checks source mailbox authorization,
reserves paid inference idempotency, and settles response plus audit together.

## Shared mail mutation use cases

CAP-070 moves authored-mail transactions out of HTTP handlers. The messages
module exposes `createDraft`, `readDraft`, `updateDraft`, `markRead`, `toggleStar`
and `softDeleteMessage`; outbound-mail exposes `submitMessage` and `sendDraft`.
HTTP adapters retain global permission middleware. MCP retains its independent
D1 credential, token mailbox/operation scopes, global permission checks and tool
audit; its draft/send tools invoke these public operations directly. Read/AI MCP
adapters retain their existing internal routing in this slice.

Use cases check mailbox authorization themselves, including cached responses.
Draft association resolution and authored-message/folder statements belong to
messages; signatures owns signature lookup/sanitization; outbound-mail coordinates
signatures/editor assets, attachment consumption, message statements and outbox.
The admin audit writer accepts an optional per-request idempotency marker guard,
so conditional draft batches do not duplicate admin-owned audit SQL. The
composition root supplies audit, clock and ID collaborators; no use case receives
Hono context, raw Env or constructs a Fetch Response.

Serialized operation results preserve status, JSON bytes and resource Location.
Raw request material stays available to shared schema validation and existing
idempotency hashing; this preserves replay ordering and compatibility with
previously stored responses. Conditional save/send writes, their own marker,
recipient/folder writes, audit and idempotency remain in one D1 batch. Queue
notification follows commit; durable outbox recovery retains authority if it
fails. Per-user mark-read retains the existing rerunnable best-effort replay
record policy (D-CAP-043-I); star/delete remain atomic. No schema change.
