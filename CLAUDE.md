# Repository guide

Unimailbox's agent entry point. Follow the current user instructions and the
host's tool and permission rules first. Repository guidance supports that work;
it does not authorize additional agents, deployments, messages, or history rewrites.

## State recovery — fresh session

1. Check `git status`, branch, upstream and recent commits. Preserve unrelated work.
2. Read [current state](docs/rebuild/capability-ledger.md#current-state) and
   [execution plan](docs/rebuild/execution-plan.md).
3. Inspect `work/active/` and any relevant task or handoff. An empty directory is
   valid when no capability is active.
4. Read the latest dated entry in `docs/rebuild/implementation-log.md` and the
   documentation for the requested behavior.
5. Confirm claims against source, configuration and dated validation evidence.
   Earlier phase tables and archived reports are historical snapshots.

Claude Code's SessionStart hook supplies a compact orientation. Other tools must
perform these checks themselves; hooks are not proof of correctness or delivery.

## Directory map

| Path | Purpose |
| --- | --- |
| `README.md` | Product, local development and deployment entry points |
| `docs/rebuild/README.md` | Design navigation and current versus historical material |
| `docs/rebuild/capability-ledger.md` | Current execution state and dated delivery history |
| `docs/rebuild/execution-plan.md` | Remaining work and historical recovery sequence |
| `docs/rebuild/implementation-log.md` | Dated change log |
| `.claude/rules/` | Architecture, security, testing and working conventions |
| `.claude/agents/` | Optional specialized role briefs |
| `.claude/skills/` | Capability, review, audit, business-loop and cleanup procedures |
| `.claude/templates/` | Task, review and handoff forms |
| `.claude/hooks/` | Claude Code guardrails; behavior and limitations in its README |
| `work/` | Active contracts, reviews, investigations, handoffs and archives |
| `.tmp/` | Ignored private scratch; never publication material |

## Execution model

The main session owns implementation, coordination, validation and the final
report. Work directly unless delegation is authorized and available. When using
subagents, follow `.claude/rules/agent-collaboration.md`: explicit scope and reading
list, one writer per file, and no nested delegation by default. A delegated
reviewer must be independent of the implementation. Report a self-check as a
self-check when no independent review occurred.

Keep one major capability active by default. Additional work needs disjoint file
ownership and a recorded reason. Do not reopen a completed slice merely because
an old roadmap or report still describes it as pending.

## Validation and documentation

- The canonical implementation gate is `pnpm verify`; choose focused checks for
  documentation-only work as described in `.claude/rules/testing.md`.
- Separate local checks, browser observations, deployment and provider evidence.
  Passing tests alone does not establish staging or production acceptance.
- Resolve contradictions in the owning document and link to it elsewhere.
  Preserve dated history with an explicit historical label.
- External references require pinned provenance and preserved licenses; see
  `.claude/rules/reference-implementations.md`.
- Store durable handoffs under `work/handoffs/`, with scope, evidence and remaining
  work. Never put credentials, message bodies or private artifacts in a handoff.

## Tool and Git conventions

Use the host's available tools; prefer `rg` for repository searches. Scratch goes
in `.tmp/`. Inspect diffs and stage named paths. Commit or publish within the
user's authorized scope, retaining authorization from earlier turns. Use a
feature branch (`codex/` for Codex), and do not rewrite shared history without
explicit authorization. The project's requested commit identity is
`JohnJiang <johnjiang@leanda.tech>` for both author and committer.

Before publication, follow [repository hygiene](docs/operations/repository-hygiene.md).
