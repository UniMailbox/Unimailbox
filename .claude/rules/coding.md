# Coding Rules

## Language and stack

TypeScript end-to-end, `strict: true`. Hono on the Worker. Drizzle for typed schema (SQL migrations
are the deployable artifact). React + TanStack Query + Zustand + React Hook Form + Zod + Tiptap +
Dexie + shadcn-style primitives on the client. Do not introduce a competing library for a job one of
these already does.

`any` is a review finding. Use `unknown` plus a narrowing check, or model the type properly.

## Abstraction discipline

**Rule of Three** — do not introduce a generic abstraction until **three** concrete use cases exist.
Two similar call sites is a coincidence. The `OutboundProviderAdapter` registry is pre-approved by
ADR-002; nothing else is.

Prefer explicit business code over generic framework code. A named function that does one business
thing beats a configurable one that does four.

Corollaries:

- No base classes "for future providers". No `BaseService`, no `AbstractRepository`.
- No config-driven branching where a second function would do.
- No dependency injection container. Wiring happens in `app-context.ts`, by hand, explicitly.
- Delete dead code rather than commenting it out — git remembers.

## Structure

- A module's `index.ts` is its entire public API. Everything else is private (`.claude/rules/architecture.md`).
- Route handler: validate → call one use case → map result to the response envelope. Nothing else.
- Use case: orchestrate. May call repositories, domain services, and integrations **through
  interfaces declared in `packages/contracts`**.
- Domain: pure. Entities, value objects, state machines. No I/O, no `Date.now()` — take a `Clock`
  from `platform/clock.ts`. No `crypto.randomUUID()` — take `platform/ids.ts`. This is what makes
  domain tests deterministic.
- Nothing over ~150 lines without a reason you can state. The legacy 311-line `send` is the
  cautionary tale.

## Naming

- Files and directories: `kebab-case`. Types and classes: `PascalCase`. Functions and variables:
  `camelCase`. Database tables and columns: `snake_case`.
- Use the glossary's terms exactly (`docs/rebuild/02-business-discovery/business-glossary.md`).
  It is `mailbox`, never `account`. It is `message`, never `email` for the stored entity.
  Renaming a domain term is an ADR.

## Errors

- Throw typed domain errors from `platform/errors.ts` carrying a stable `code`. The HTTP error
  middleware is the **only** place that maps error → status code. Handlers do not build error
  responses by hand.
- Never swallow an error to keep a happy path green. If a failure is genuinely ignorable, log it at
  `warn` with a reason.
- Never let a provider SDK error escape `integrations/` untranslated. Translate at the boundary.

## Data

- Relational columns only. **JSON-in-text columns are forbidden** (`R-DATA-005`).
- Multi-row writes that must be atomic go in a single D1 batch — notably inbound message insert
  (`R-INBOUND-008`) and send + job + idempotency record (`R-OUTBOUND-006`).
- IDs are UUIDs (ADR-005), generated via `platform/ids.ts`.

## Dependencies

Adding a runtime dependency requires: a named concrete need, a check that the stack above does not
already cover it, and a note in the capability's `task.md`. Prefer the Web Crypto API and platform
primitives over a package. Every dependency is a Worker bundle-size and supply-chain cost.

## Comments

Comment *why*, not *what*. A comment restating the code is noise. Cite the rule ID when code exists
to satisfy a business invariant:

```ts
// R-MAILBOX-003: the owner is implicitly a member and must not be added explicitly.
```
