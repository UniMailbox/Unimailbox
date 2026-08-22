# Cloud Mail — Rebuild Documentation

This folder contains the complete analysis, design, and roadmap for rebuilding Cloud Mail. The rebuild happens in a **new repository** from scratch — this folder is the **requirements and design specification** for that new repo, derived from an analysis of the current codebase.

## How to read this

**Start here:**

- `00-executive-summary.md` — what we're building and why.

**Then read in order:**

- `01-current-system/` — what exists today (the "old" reference implementation).
- `02-business-discovery/` — what the business actually is.
- `03-domain-design/` — the proposed domain model.
- `04-legacy-review/` — what's wrong with the existing system (anti-patterns to avoid).
- `05-target-architecture/` — what we're building in the new repo.
- `06-business-loops/` — the closed loops that define success.
- `07-migration/` — how existing data is imported into the new system (one-time).
- `08-roadmap/` — the phased delivery plan.
- `09-decisions/` — Architecture Decision Records (ADRs).
- `10-open-questions.md` — questions still needing operator input.
- `11-agentic-inbox-adaptation.md` — pinned upstream implementation patterns and what this project
  adopts, adapts, or rejects.
- `execution-plan.md` — the ordered recovery and implementation plan.

**Top-level deliverables:**

- `A-...md` through `J-...md` — the 10 executive outputs requested in §A–§J of the brief.

## Premise

The rebuild is greenfield. We do **not**:

- Fork this repo.
- Modify any code in `mail-worker/`, `mail-vue/`, or `mail-react/`.
- Maintain a "strangler" bridge between legacy and the new system.
- Maintain two web clients.

We **do**:

- Use this repo as a **reference**: extract business facts, identify anti-patterns, capture requirements.
- Stand up a new repository with the architecture in `05-target-architecture/`.
- Import data from the legacy D1 into the new D1 via a one-time migration script (built in Phase 4).
- Decommission the legacy deployment after a documented cutover window.

## Source-of-truth split

| Artifact | Owner |
|---|---|
| New repo code | New repo |
| Data migration script | New repo (`scripts/migrate-from-legacy/`) |
| Business rules + glossary | This doc (`02-business-discovery/`) |
| Architecture decisions | This doc (`09-decisions/`) |
| Legacy reference | This repo (read-only) |

When the new repo diverges from a doc here, the doc is updated, not the other way around.

## Live execution state

This folder is the **design specification** and is stable. Current delivery status lives in two
files alongside it, and those are what a recovering agent reads first:

- `capability-ledger.md` — what is done, in progress, blocked, and next (authoritative)
- `implementation-log.md` — what changed recently and why

Agent operating rules, roles, and procedures are in `CLAUDE.md` and `.claude/` at the repository root.

## Phase progress

Superseded by `capability-ledger.md` §Phase progress, which is kept current. Retained here for the
original exit-criteria counts. The H-doc numbers below disagree with the source files in places —
the ledger's `Known documentation discrepancies` table records each.

| Phase | Status | Exit criteria | When |
|---|---|---|---|
| 0 — Foundation | **Reopened — preview unverified** | 11 boxes — `08-roadmap/phase-0-foundation.md` | CAP-039/041 implement `/setup`, asset delivery, queue topology, and repeat-safe migrations locally; fresh and repeat preview evidence remains pending in CAP-045. |
| 1 — Minimal Loop | **Reopened — user loop incomplete** | 29 boxes — `F-minimal-business-closed-loop.md` §F.4 (H doc says 23) | CAP-041 implements the setup wizard; auth, mailbox, inbox, compose/reply, admin UI, and the real browser/email loop remain CAP-042–045. |
| 2 — Reliable Loop | **In progress — CAP-042 active** | 7 boxes — `08-roadmap/phase-2-core-loop.md` | CAP-027–032, CAP-035, and CAP-037–041 are implemented; CAP-042 Slice 0 and migration 0014 are complete, with runtime auth config/factory next. |
| 3 — Complete Core | Not started | drafts + attachments | — |
| 4 — Operations + Data Import | Not started | ops tooling + legacy import | — |
| 5 — Automation | Not started | — | — |
| 6 — Scale | Not started | — | — |

## Capability ledger

`capability-ledger.md` in this folder. It allocates the `CAP-NNN` IDs (the specification below
assigns none), tracks status per capability, and records deferrals and known doc discrepancies.
`I-legacy-new-mapping.md` and `H-progressive-rebuild-roadmap.md` remain the *requirements* source
the ledger is derived from.

## Process

The rebuild follows the cross-cutting rules in `.claude/rules/`. Rule of Three and Rule of One are
defined in `coding.md` and `agent-collaboration.md`. External code-pattern provenance is defined in
`reference-implementations.md`.

## Stop-the-line conditions

If any of the following occur, pause implementation and re-plan:

1. A user is locked out of their data during data import.
2. A measured benchmark shows the rebuild Worker exceeds the 30s wall-clock budget under realistic load.
3. A schema migration causes irreversible data loss.
4. The Brevo adapter fails in a way that loses messages.
5. The setup wizard allows installation to complete without a working smoke test.
6. The audit log reveals unauthorized access to messages or credentials.
7. A new business requirement arrives that does not fit any current phase.

## What we are NOT doing

- Big-bang rewrite of this repo.
- Multi-tenant isolation beyond per-deployment boundaries.
- Microservice decomposition.
- Generic plugin system.
- Arbitrary event bus.
- External workflow engine.
- Dynamic configuration.
- Premature abstractions.
- **Maintaining a second web client** — there is exactly one.

## What we ARE doing

- Building in a fresh repo with the architecture defined here.
- Vertical-slice delivery, one capability at a time.
- TypeScript + Hono + Drizzle end-to-end.
- Explicit state machines with documented transitions.
- Provider plugin registry with neutral contracts.
- Durable outbox + queue consumer for outbound.
- Setup wizard with resumable state.
- Encrypted credentials + Secrets Store.
- PBKDF2 + constant-time verification.
- Cursor-based pagination.
- Idempotency on all mutating endpoints.
- Audit log on every state transition.
- Structured logging with request IDs.
- One-time data import from the legacy D1 (Phase 4).
- **One web client only**: built in the new repo, no Vue or React-from-this-folder inherited.
