# Agent Collaboration Rules

How multiple agents work on this repository without corrupting each other's work or the project's
memory.

## The premise

Agent context is **not** a source of truth. Sessions reset, models change, context windows drop.
Anything a future agent needs must be in the repository before your turn ends.

## Main Agent (orchestrator)

Owns coordination and acceptance, not implementation volume. Responsibilities:

- Determine current phase and next capability from `docs/rebuild/capability-ledger.md`.
- Reconcile the ledger's active CAP with `work/active/`, Git status, and the actual code path before
  selecting more work. Fix state drift before implementation.
- Write the capability contract at `work/active/CAP-NNN-slug/task.md` before delegating.
- Assign file ownership and scoped reading lists.
- Delegate implementation and **independent** review.
- Run quality gates; accept or reject subagent output.
- Update the ledger and implementation log; clean up `work/active/`; commit.

The orchestrator is the final owner of repository hygiene. See `CLAUDE.md` §Execution model.

## Subagents

- Implement **only** the assigned scope. Out-of-scope improvements go in the report as a
  recommendation, not in the diff.
- Do not redesign unrelated modules. Do not "fix" adjacent code you happened to read.
- Do not edit `.claude/rules/`, `CLAUDE.md`, or `docs/rebuild/` design specs. Propose instead.
- Report assumptions explicitly. An unstated assumption is how two subagents build incompatible halves.

## File ownership

Every capability's `task.md` declares which files each agent owns.

- **Exactly one agent writes a given file at a time.** No exceptions.
- If two slices need the same file, the orchestrator sequences them; it does not run them in parallel.
- Reading a file you do not own is always fine. Writing it is never fine.
- Discovering you need to change a file you do not own → stop, report it, let the orchestrator decide.

## WIP limits

- **One capability in `work/active/` at a time**, by default. A second requires genuinely disjoint
  file ownership and an explicit note in the ledger saying why.
- At most one implementer per file set. Reviewers may run in parallel with each other.
- Rule of One: one vertical slice (domain → persistence → use case → API → UI → tests) at a time.
  Never a horizontal "all the backend, then all the frontend" split.

## Review independence

**A reviewer must not have written the code it reviews.** A fresh subagent, given the task contract
and the diff, is the whole point — an agent reviewing itself reproduces its own blind spots.

Reviewers challenge; they do not summarize. A review that restates the diff has failed. Every
finding needs a concrete failure scenario: inputs or state → wrong behaviour.

Severity, and what it means:

| Severity | Meaning |
|---|---|
| BLOCKER | Ship-stopping: data loss, auth bypass, invariant violation, architecture rule broken |
| HIGH | Wrong under a realistic condition; must fix before the capability is accepted |
| MEDIUM | Should fix; may be a follow-up capability if recorded in the ledger |
| LOW | Style, naming, minor duplication |

## Handoff format

Every agent's final message is structured. No prose-only reports.

```
Task:      CAP-NNN — <what was asked>
Status:    COMPLETE | PARTIAL | BLOCKED

Changes:   <what actually changed, behaviourally>
Files:     <exact paths, one per line — or "no code changed" for investigations>
Tests:     <added / run / results, verbatim pass-fail>
Findings:  <severity-tagged>
Risks:     <assumptions, things you could not verify>
Next:      <recommended next concrete action>
```

An investigation agent must state **"no code changed"** explicitly. An implementation agent must
list exact changed paths — the orchestrator stages by that list.

## Conflict handling

- Two reviewers disagree → the orchestrator decides and records the reasoning. If it constrains
  future work, it becomes an ADR.
- Subagent output contradicts a rule → the rule wins. Reject the output.
- A rule contradicts `docs/rebuild/` → `docs/rebuild/` wins for design questions; `.claude/rules/`
  wins for agent behaviour. Flag the contradiction; do not paper over it.
- A rule appears wrong → produce a proposal, do not edit it (see below).

## Result validation

The orchestrator does not take a subagent's word for anything checkable:

- Claimed files changed → verify with `git status`/`git diff`.
- Claimed tests pass → run them.
- Claimed acceptance criteria met → check against `task.md`.
- Claimed feature or phase complete → trace the browser/API/entrypoint/configuration path that makes
  it usable. An exported handler without a trigger and a built asset without serving configuration
  are both incomplete.
- Claimed external pattern followed → verify the pinned commit, inspected files, adaptation, and
  rejected assumptions recorded under `.claude/rules/reference-implementations.md`.

A subagent reporting COMPLETE on unrun tests is a process failure, not a small one.

## Rules change policy

`.claude/rules/` and `CLAUDE.md` are high-impact. A subagent must never edit them to make its own
task pass. To change a rule: write a proposal (what, why, what breaks), hand it to the orchestrator,
and let the orchestrator apply it as its own change with the reasoning recorded.

## Skills change policy

```
repeated workflow → stable procedure → skill
```

Do not create a skill the first time a workflow appears. Promote it when the same procedure has run
successfully across at least three capabilities and its steps have stopped changing.

## No hidden decisions

If you made a decision during implementation that future work depends on, classify it and persist it
before your turn ends:

- Constrains agent behaviour → `.claude/rules/`
- Architectural, with alternatives considered → ADR
- Business rule → `docs/rebuild/02-business-discovery/business-rules.md`
- Notable but local → `docs/rebuild/implementation-log.md`

If a decision exists only in this conversation, it does not exist.
