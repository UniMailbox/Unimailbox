# AGENTS

This file is the root entry point for AI agents working in this
repository. The detailed coordination protocol — which persona to
spawn, how to hand off between agents, and which tools are available —
lives in `.agents/AGENTS.md`. Read it before delegating.

## Roster

Persona definitions and the coordination protocol are in
[`.agents/AGENTS.md`](.agents/AGENTS.md). Treat that file as the source
of truth for who does what.

## Documentation Rules

`docs/` contains canonical project documentation (architecture, API,
development, operations, adr). It is the source of truth for what
the system does today.

`.agent/tasks/<id>/` is the per-task workspace for non-trivial Agent
work (use `context.md`, `plan.md`, `research.md`, `decisions.md`,
`result.md` as needed).

`.agent/scratch/` is disposable and gitignored.

`artifacts/reports/` is for dated point-in-time output (audits,
contract diffs, coverage runs).

`docs/adr/ADR-NNN-*.md` records decisions with long-term
architectural significance. Promote a `.agent/tasks/<id>/decisions.md`
finding into an ADR when its rationale outlives the task.

The full documentation policy lives at
`docs/development/agent-documentation-rules.md`.

## Task Completion Checklist

Before completing a non-trivial task:

- [ ] Implementation matches the plan.
- [ ] Relevant tests added or updated, and they pass.
- [ ] API/schema changes documented in `docs/api/` or `docs/architecture/`.
- [ ] Architecture updated where it changed.
- [ ] ADR created/updated if a long-term decision was made.
- [ ] Configuration / env-var changes documented.
- [ ] `.agent/` working docs do not leak into `docs/`.
- [ ] Long-term knowledge promoted out of `.agent/`.
- [ ] `result.md` summarises the task (when a task workspace exists).
