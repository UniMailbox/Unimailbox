# CAP-NNN — <Capability Name>

> The shared contract for this capability. Every agent working on it reads this file first.
> Location: `work/active/CAP-NNN-slug/task.md`. Delete this quote block when filling in.

**Phase:** N · **Status:** In Progress · **Started:** YYYY-MM-DD

## Goal

<One sentence, in business terms. What can a user or operator do afterwards that they could not before?>

## Scope

- <Specific, bounded deliverable>

## Out of scope

- <What an agent might reasonably assume is included but is not, and which capability owns it>

> This section prevents more drift than the Scope section does. Be generous with it.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-XXX-NNN` | <concrete obligation on this code> |

Source: `docs/rebuild/02-business-discovery/business-rules.md`.

## Acceptance criteria

Objectively checkable. No "works correctly". Each maps to a test or a demonstrable behaviour.

- [ ] 1. <criterion>
- [ ] 2. <criterion>

## Vertical slice

Layers this touches, in dependency order:

- [ ] domain — `<path>`
- [ ] migration — `migrations/NNNN_*.sql` (+ `.verify.sql`)
- [ ] repository — `<path>`
- [ ] use case — `<path>`
- [ ] contract schema — `packages/contracts/<path>`
- [ ] route — `<path>`
- [ ] client — `apps/web/src/features/<path>`
- [ ] tests — `<paths>`

New module dependency edges introduced: `<none>` / `<a → b>` — each must appear in the dependency
table in `docs/rebuild/05-target-architecture/module-boundaries.md`, or be approved by the orchestrator first.

## Delivery path

Trace the real invocation, not only the module calls:

`<browser / HTTP / email / queue / scheduled>` → `<Worker route or entrypoint>` → `<use case>` →
`<persistence/provider>` → `<user-visible or operator-visible result>`

- Build/runtime configuration touched: `<paths or none>`
- Fresh-deploy evidence required: `<yes/no and command/scenario>`
- Repeat-deploy/idempotency evidence required: `<yes/no and command/scenario>`

## Reference implementation

Use `None` when there is no external reference. Otherwise follow
`.claude/rules/reference-implementations.md`.

| Field | Value |
|---|---|
| Repository + pinned commit | `<URL>@<SHA>` |
| License | `<license>` |
| Files inspected | `<exact upstream paths>` |
| Adopt | `<behavior/pattern>` |
| Adapt | `<Unimailbox-specific changes>` |
| Reject | `<upstream assumptions not carried over>` |
| Attribution needed | `<yes/no; where>` |

## File ownership

One writer per file. Reading anything is fine; writing outside your list is not.

| Agent | Owns |
|---|---|
| implementer-1 | `<exact paths>` |
| implementer-2 | `<exact paths>` |

## Reading list

Give each subagent exactly this — not the whole `docs/` tree.

- `CLAUDE.md` (the Claude Code entry point)
- this file
- `.claude/agents/<role>.md`
- `.claude/rules/<the one or two that apply>.md`
- `docs/rebuild/<specific design docs>`

## Dependencies

- Requires: CAP-NNN (<name>) — status
- Blocks: CAP-NNN (<name>)

## Decisions made during this capability

<Append as you go. At close, each is promoted to a rule, an ADR, the implementation log — or deleted
as not load-bearing. Nothing stays only here.>

## Open questions

<Blockers needing the orchestrator or the operator. An unanswered question is not an excuse to guess.>
