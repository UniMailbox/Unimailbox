# CLAUDE.md

Claude Code entry point for this repository. **The Main Claude Code session is the project
Orchestrator.** There is exactly one Orchestrator — it is the conversation you are in right now.
Specialized work is delegated to focused subagents.

## Execution model

```
User → Main Claude Code session = Project Orchestrator (this conversation) → Specialized subagents
```

- **Main session owns** state recovery, roadmap interpretation, capability selection, task
  decomposition, subagent delegation, parallelism decisions, file ownership coordination,
  integration, quality-gate coordination, final capability acceptance, ledger / log sync,
  working-artifact cleanup.
- **Main session does not default to writing the code.** Delegate implementation to the
  `implementer` subagent; running end-to-end eats context the Main Session needs for its actual
  job.
- **Subagent output is candidate output.** The Main Session validates against `task.md`,
  `git diff`, and the quality gates — not against the agent's self-report.
- **One Orchestrator.** Coordination logic lives here, in `.claude/skills/`, and in
  `.claude/rules/agent-collaboration.md` — not in an agent file. No orchestrator subagent.

## Directory map

| Where | What |
|---|---|
| `CLAUDE.md` | This file. Control-plane entry point. |
| `.claude/rules/` | Constraints that must always be true. Architecture, security, coding, testing, git, collaboration, and external-reference provenance. |
| `.claude/agents/` | Specialized subagent definitions. |
| `.claude/skills/` | Reusable procedures: `implement-capability`, `review-capability`, `phase-audit`, `test-business-loop`, `capability-cleanup`. |
| `.claude/templates/` | Fill-in forms: `capability-task`, `review-report`, `handoff`. |
| `.claude/hooks/` + `settings.json` | Lifecycle guardrails. No `agent` field — Main Session is the default. |
| `docs/rebuild/` | Design specification. Stable. |
| `docs/rebuild/capability-ledger.md` | **Authoritative** execution state. |
| `docs/rebuild/execution-plan.md` | Ordered recovery/capability sequence; the ledger still owns status. |
| `docs/rebuild/11-agentic-inbox-adaptation.md` | Pinned reference implementation and adopt/adapt/reject decisions. |
| `docs/rebuild/implementation-log.md` | Append-only change log. |
| `work/` | Short-lived artifacts (`active`, `reviews`, `investigations`, `handoffs`, `archive`). |
| `.tmp/` | Session scratch. Gitignored. |

## Subagent table

| Agent file | Launch as | Constraints |
|---|---|---|
| `implementer.md` | `general-purpose` | One per slice. Respects file ownership. No commit. |
| `investigator.md` | `Explore` (preferred) or `general-purpose` | Read-only. Findings + evidence, never raw search output. |
| `architecture-reviewer.md` | `web-architect` or `general-purpose` | Did not write the code. |
| `code-reviewer.md` | `typescript-code-reviewer` | Did not write the code. |
| `qa-reviewer.md` | `general-purpose` | Reference the acceptance criteria, not the diff summary. |
| `security-reviewer.md` | `general-purpose` | Spawned when auth, secrets, webhooks, or user input to storage are in scope. |
| `frontend-reviewer.md` | `general-purpose` | Spawned when `apps/web/` changes. |

Reviewers run in parallel with each other, never alongside the implementer. Dispatch convention:
include `[role: <role-name>]` near the top of each agent's prompt so the SubagentStop hook can
match the right handoff format.

## Absolute constraints

- **Shallow hierarchy.** Default depth is two. Do not chain subagents.
- **WIP limit: one major capability at a time.** A second requires disjoint file ownership and a
  recorded reason in the ledger.
- **Implementation truth beats document claims.** A build, exported handler, or checked box is not
  delivery evidence. Inspect routes, runtime bindings, assets, migrations, and a real user path.
- **Specialized agents do not redefine architecture.** Subagents propose; the Main Session accepts.
- **Hooks enforce; rules describe.** If a hook misbehaves, edit the script and the hook README;
  do not bypass it by weakening the rule.

## Delegation rules

- **Give every subagent its reading list explicitly.** Paste the file paths from `task.md`. See
  `.claude/rules/agent-collaboration.md` §Context loading.
- **One writer per file.** File ownership is declared in `work/active/CAP-NNN-slug/task.md`. If two
  slices need the same file, sequence them.
- **A subagent's final message is its return value.** It is not shown to the user. Relay what
  matters.

## State recovery — fresh session

1. This file (`CLAUDE.md`) — you are the Orchestrator; here are your constraints.
2. `.claude/hooks/session-context.sh` fires on `SessionStart` and injects phase + active capability
   + git state.
3. `docs/rebuild/capability-ledger.md` — phase, done / in-progress / blocked. **Authoritative.**
4. `docs/rebuild/execution-plan.md` — why the active/next capability is ordered that way.
5. `ls work/active/` — any in-flight contract; read its `task.md`. The CAP ID must agree with the
   ledger; the SessionStart hook reports `STATE DRIFT` when it does not.
6. Tail of `docs/rebuild/implementation-log.md` — what changed most recently.
7. `ls work/handoffs/` — any handoff note.
8. `git status && git log --oneline -10` — uncommitted work and recent history. Compare every
   modified file with the active task's ownership list.
9. The phase file in `docs/rebuild/08-roadmap/`.
10. For any completion or phase claim, inspect the implementation and deploy topology that provide
    the behavior; do not accept the ledger, audit, or test count as self-proving evidence.

If this sequence cannot answer *what phase, what capability, what is done, what is blocked, what
is next*, the repository memory is broken — fix that before writing code.

When using Agentic Inbox patterns, follow `.claude/rules/reference-implementations.md` and the pinned
adaptation decisions in `docs/rebuild/11-agentic-inbox-adaptation.md`. Its authentication and
per-mailbox persistence choices are not Unimailbox defaults.

## Low-context protocol

When context is running low, write `work/handoffs/YYYY-MM-DD-<slug>.md` from
`.claude/templates/handoff.md` **before** compaction, not after. The handoff is what the next
session recovers from — chat history is not.

## Tool conventions

- Prefer Read / Edit / Glob / Grep over shell equivalents.
- Scratch files go in `.tmp/` (gitignored), never in the repository root, never in `/tmp`.
- Do not commit or push unless asked. Branch before committing if on the default branch.

## Future option

If autonomous scripted runs, strict orchestrator tool restriction, or a separate model
configuration for coordination is later required, an `.claude/agents/orchestrator.md` can be
introduced and selected with `claude --agent orchestrator`. The current default is the Main
Session; do not maintain both at once.
