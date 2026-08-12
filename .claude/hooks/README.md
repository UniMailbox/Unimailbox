# Claude Code Hooks

Deterministic guardrails around the AI agent lifecycle. Hooks do not duplicate the rules in
`.claude/rules/` or `CLAUDE.md` — they reference and enforce them. If a rule changes there,
update any matching logic here too.

## Hooks

| Hook | Event | Purpose | Blocking |
| --- | --- | --- | --- |
| `session-context.sh` | `SessionStart` | Inject a small execution-state context (current phase, active workspace, recent log, git state) so a fresh session can orient without re-reading the whole repo | No |
| `protect-destructive-commands.sh` | `PreToolUse` (Bash) | Block high-confidence irreversible shell operations (`rm -rf .`, `git reset --hard`, `git clean -fdx`, force-push to main/master/production, `DROP DATABASE`/`DROP SCHEMA`) | Yes — exit 2 |
| `protect-root-pollution.sh` | `PreToolUse` (Write, Edit, MultiEdit) | Block new files at the repository root whose name matches the governance rule's forbidden patterns (`PLAN.md`, `NOTES*.md`, `DEBUG.txt`, etc.). Use `work/`, `.tmp/`, or the explicit allowlist instead | Yes — exit 2 |
| `subagent-start-context.sh` | `SubagentStart` | Inject repository guardrails + a role-specific reminder into every specialised subagent. Common block + per-role appendix (implementer / reviewer / architect / QA / security / investigator / frontend / explore) | No |
| `validate-subagent-stop.sh` | `SubagentStop` | Refuse to let an implementer-class subagent finish without a structured handoff (Status / Files / Tests headings for implementers; ## BLOCKER / HIGH / MEDIUM / LOW sections for reviewers). Read-only roles are exempt | Yes — exit 2 |
| `validate-task-completed.sh` | `TaskCompleted` | Block closing a `CAP-NNN` capability while any `BLOCKER` or `HIGH` review finding remains in `work/reviews/`. Also blocks "task claims success but the message contains a `FAIL` line" | Yes — exit 2 |
| `protect-config-change.sh` | `ConfigChange` (settings) | Log a loud audit entry every time a governance file (`.claude/settings.json`, `CLAUDE.md`, `.claude/rules/`, `.claude/agents/`, `.claude/skills/`, `.claude/hooks/`) is changed. Does not block — the orchestrator's review is the real safeguard; this hook makes the change visible | No |

## Event payload schema (assumed)

Each hook reads JSON from stdin. The exact field names vary by event; the hooks probe a few
candidate names and degrade gracefully if a field is absent. The specific fields read:

| Event | Fields read |
| --- | --- |
| `SessionStart` | (none — synthesises its own context) |
| `PreToolUse` (Bash) | `tool_input.command` |
| `PreToolUse` (Write/Edit) | `tool_input.file_path` (or `path`/`notebook_path`) |
| `SubagentStart` | `agent_type` (or `subagent_type` / `subagent.agent_type` / `type`) |
| `SubagentStop` | `agent_type`, `agent_transcript_path` (or `transcript_path` / `subagent.transcript_path`) |
| `TaskCompleted` | `task_description`, `description`, `status`, `result`, `content`, `message` |
| `ConfigChange` | `file_path` (or `path` / `config_path`) |

If the field is absent, the hook fails open (allows the action and logs the gap).

## Failure behaviour

| Hook | Failure behaviour |
| --- | --- |
| `session-context.sh` | Never blocks. Prints a degraded context and exits 0 on any read failure |
| `protect-destructive-commands.sh` | High-confidence block on a small, named set of patterns. Fails open (allow + log) on jq or input failure |
| `protect-root-pollution.sh` | Block on name-pattern match. Fails open on jq or path-resolution failure |
| `subagent-start-context.sh` | Never blocks. Prints the common block on any failure |
| `validate-subagent-stop.sh` | Fails open if the transcript is unreadable. Blocks if headings are missing |
| `validate-task-completed.sh` | Fails open if jq fails. Blocks if the payload mentions a CAP-NNN with open review findings, or claims success while containing `FAIL` |
| `protect-config-change.sh` | Never blocks. Logs always |

## Logging

Hooks write one line per invocation to `.tmp/claude-hooks/hooks.log`:

```
2026-08-11T07:30:00Z session-context.sh session-start begin
2026-08-11T07:30:00Z session-context.sh session-start end phase='Phase 0 — Foundation' active='CAP-001-monorepo-scaffold' branch='master'
2026-08-11T07:30:05Z protect-destructive-commands.sh destructive-guard BLOCKED: rm -rf of root, home, or current/parent directory :: rm -rf .
```

Logs never contain payloads (so no secrets), only the hook name + event + a short reason. The
`.tmp/` directory is gitignored.

## How to test each hook

Each script reads JSON from stdin and exits 0 (allow) or 2 (block). Run them directly:

```bash
# Allow path
echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' \
  | .claude/hooks/protect-destructive-commands.sh
# rc=0

# Block path
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf ."}}' \
  | .claude/hooks/protect-destructive-commands.sh
# rc=2, stderr explains the block

# Root pollution block
echo '{"tool_name":"Write","tool_input":{"file_path":"/path/to/repo/PLAN.md","content":"x"}}' \
  | .claude/hooks/protect-root-pollution.sh
# rc=2

# Subagent stop without handoff
echo '{"agent_type":"implementer","agent_transcript_path":"/tmp/empty.txt"}' \
  | .claude/hooks/validate-subagent-stop.sh
# rc=2

# TaskCompleted with open CAP review
echo '{"task_description":"CAP-001 done","status":"DONE"}' \
  | .claude/hooks/validate-task-completed.sh
# rc=2 if work/reviews/CAP-001-*.md has BLOCKER/HIGH entries

# Session context (no input needed, generates its own)
.claude/hooks/session-context.sh
```

Replace `/path/to/repo` with the absolute path of the repository root.

## What this directory does NOT contain

- Hooks that fire on `Stop`, `TaskCreated`, `PreCompact`, `PostCompact`, `PostToolUse`,
  `TeammateIdle`. Listed in the design notes as "do not add yet" — each was rejected because
  it produces churn (Stop), aggressive re-runs (PostToolUse), or scope creep (the others).
  Add only when an actual incident demands them.
- Hooks that read full transcripts and run heavy logic. The hooks here are file-tails + jq +
  grep; even at 200-line transcript reads, the slowest script runs well under 100ms on a warm
  filesystem.
- Business logic. Hooks do not implement product rules. They enforce *process* — destructive
  commands, root pollution, handoff structure, completion gates.

## When you edit a hook

- Run `bash -n <script>` to syntax-check.
- Re-run the test list above for the script you touched.
- Update this README if the script's purpose or blocking behaviour changes.
- Update `docs/rebuild/implementation-log.md`.