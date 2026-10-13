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
| outbound-mail | tenancy, messages, editor-assets, provider integrations, email-core; audit writer contract |
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
| Messages, recipients, mailbox views, user state and drafts | messages, D1 |
| Attachment uploads and downloads | attachments with message metadata in D1 and bytes in R2 |
| Editor assets and durable usages | editor-assets, D1 + R2 |
| Domain signatures | signatures, D1, with editor-asset usage references |
| Jobs, provider connections, encrypted credentials and webhook state | outbound-mail, D1 |
| Roles, permissions, settings, audit, blocklists and role policies | admin, D1 |
| MCP service/prompt configuration, personal credentials, scopes and rate windows | admin, D1; personal transport derives the credential owner from the session |
| AI configuration and encrypted AI credentials | admin, D1; AI adapters and service wired by app-context |
| Idempotency infrastructure | platform helpers; business modules batch their records with writes |

Resource cleanup goes through these ownership boundaries. Published editor
usages protect historical mail; private incoming attachments retain mailbox
authorization. See [editor storage](../16-email-editor-storage.md) and
[storage decision](../14-durable-object-mailbox-adr.md).

AI service details and configuration semantics: [AI service foundation](../18-ai-service-foundation.md).

Email AI reply orchestration belongs to messages. Its AI service and audit writer
are neutral contracts supplied by HTTP composition, without dependencies on the
AI/admin modules or SDKs. The use case checks source mailbox authorization,
reserves paid inference idempotency, and settles response plus audit together.
