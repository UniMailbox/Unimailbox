# Hooks Audit — 2026-08-11

**Scope:** the seven hook scripts (six lifecycle hooks + two lib helpers) in `.claude/hooks/`
and their wiring in `.claude/settings.json`.
**Auditor:** independent subagent + own per-test verification.

## Status

**PASS** — every blocking hook blocks the right things and allows the right things. The
independent audit agent identified four defects in `protect-destructive-commands.sh`
(2 HIGH + 2 MEDIUM); all four were fixed and re-verified. No open HIGH/BLOCKER findings.

## Lifecycle mapping

| Event | Hook | Blocking | Tested cases |
|---|---|---|---|
| SessionStart | `session-context.sh` | No | empty state (PASS), populated state (PASS), junk stdin (PASS) |
| PreToolUse (Bash) | `protect-destructive-commands.sh` | Yes — exit 2 | `rm -rf .` block, `rm -rf /` block, `rm -rf build/` allow, `git reset --hard` block, `git clean -fdx` block, `git clean -fd` allow, force-push to main block, ordinary git push allow, `git status` allow, `pnpm test:unit` allow, `DROP DATABASE` block (incl. inside wrangler d1 execute) |
| PreToolUse (Write\|Edit\|MultiEdit) | `protect-root-pollution.sh` | Yes — exit 2 | `PLAN.md` at root block, `NOTES_NEW.md` block, `debug.txt` block, write to `work/active/...` allow, write to `AGENTS.md` allow, write to `.tmp/...` allow, write to `src/foo.ts` allow |
| SubagentStart | `subagent-start-context.sh` | No | implementer/reviewer/architect/QA/frontend/explore all emit common + role-specific appendix |
| SubagentStop | `validate-subagent-stop.sh` | Yes — exit 2 | implementer with full handoff allow, implementer missing Status block, code-reviewer with all four sections allow, code-reviewer missing BLOCKER section block, explore exempt, missing transcript allow (fail-open) |
| TaskCompleted | `validate-task-completed.sh` | Yes — exit 2 | no CAP and no green claim allow, CAP-001 with no review file allow, CAP-001 with BLOCKER review block, green claim without FAIL allow, green claim with FAIL block, investigation-only task (no green claim, no CAP) allow |
| ConfigChange | `protect-config-change.sh` | No | governance file modified logged + noticed, unrelated file silent allow |

## Files changed

- `.claude/hooks/{session-context,protect-destructive-commands,protect-root-pollution,subagent-start-context,validate-subagent-stop,validate-task-completed,protect-config-change}.sh`
- `.claude/hooks/lib/{log,project-state}.sh`
- `.claude/hooks/README.md`
- `.claude/settings.json`
- `.gitignore` — `.tmp/claude-hooks/` added
- `docs/rebuild/implementation-log.md` — appended entry

## Blocking behaviour

Hooks that block (exit 2): `protect-destructive-commands.sh`, `protect-root-pollution.sh`,
`validate-subagent-stop.sh`, `validate-task-completed.sh`. All exit 2 produces a stderr message
that names the matched pattern and (for TaskCompleted) a "required next action" list.

Hooks that do not block: `session-context.sh` (informational), `subagent-start-context.sh`
(additional context), `protect-config-change.sh` (loud audit log only). All exit 0 always.

## Quality gates

The hooks **do not run heavy quality gates**. Per `.agents/rules/testing.md`, real `pnpm
test`, `typecheck`, `lint`, `build` are orchestrator responsibilities at capability close. The
TaskCompleted hook enforces the rules it can verify mechanically (open BLOCKER/HIGH review
findings; a green claim that contains a FAIL token) and defers the rest.

## Integration with subagents

- Every specialised subagent receives a common guardrail block on start
  (`subagent-start-context.sh`). Recognised agent types get a role-specific appendix
  (implementer / reviewer / architect / QA / frontend / explore).
- Implementer-class subagents cannot finish without Status/Files/Tests headings in their
  transcript tail.
- Code-reviewer-class subagents cannot finish without `## BLOCKER / HIGH / MEDIUM / LOW`
  sections.

## Integration with capability ledger

- `validate-task-completed.sh` reads `work/reviews/${CAP}-*.md` for numbered findings under
  `## BLOCKER` and `## HIGH` sections. Matches the template
  `.agents/templates/review-report.md` exactly.
- A `CAP-NNN` mention in the task payload activates Gate 1; the absence of one means the
  hook treats the event as a non-completion event and allows.
- `session-context.sh` reads `docs/rebuild/capability-ledger.md` and
  `docs/rebuild/implementation-log.md` for orientation, but does not modify them. Ledger
  updates are still the orchestrator's responsibility.

## Integration with `work/`

- `work/active/<CAP>-*/` is read by `session-context.sh` to surface the active workspace.
- `work/reviews/<CAP>-*.md` is read by `validate-task-completed.sh` to gate completion.
- `work/active/`, `work/investigations/`, etc. are surfaced by `subagent-start-context.sh` and
  `protect-root-pollution.sh` as the correct home for in-flight artifacts.

## Tests performed

1. **Per-hook smoke tests** by the implementer: each script ran with each named input,
   confirmed exit code, confirmed stderr message.
2. **Independent audit** by a subagent (this report's structure follows that agent's prompt).
3. **False-positive audit**: ordinary file edits, ordinary `git` commands, ordinary test
   invocations, and writes to `work/active/...` and `.tmp/...` all pass without being
   blocked.

## False-positive checks

The following were confirmed allowed (exit 0) by both inline testing and the validator:

- `pnpm test:unit` (allow — does not match destructive patterns)
- `pnpm lint` (allow)
- `pnpm build` (allow)
- `git status`, `git log`, `git diff`, `git add file.ts`, `git commit -m "..."` (allow)
- ordinary `git push origin <feature-branch>` (allow)
- Write to `src/foo.ts`, `apps/worker/src/index.ts`, `docs/...`, etc. (allow)
- Write to `work/active/CAP-001/notes.md`, `work/reviews/CAP-001-review.md`,
  `work/investigations/INV-001-foo.md` (allow)
- Write to `.tmp/scratch.txt` (allow)
- Edit on existing root files (allow)

Known false-positive edge case (documented): a bash command whose source contains a
literal `rm -rf .` or `DROP DATABASE` token — even inside a single-quoted argument to
`echo` — will be blocked. This is acceptable: rewriting the test command to avoid the
literal pattern is one keystroke, and the alternative (parsing shell quoting) adds
fragility. The stderr message tells the user how to narrow.

## Defects found and fixed during development

1. **Path resolution too shallow** (HIGH, fixed). `lib/log.sh` and `lib/project-state.sh`
   used `$(dirname "${BASH_SOURCE[0]}")/../..` which lands in `.claude/`, not the repo
   root. Fixed to `../../..`.
2. **`git rev-parse --abbrev-ref HEAD` exit 128 on a fresh repo** (HIGH, fixed). With
   `set -euo pipefail`, the exit code propagated through command substitution and killed
   `session-context.sh` (and any other script that called `ps_git_branch`/`ps_git_dirty`).
   Fixed by appending `|| true` to the command substitution.
3. **`DROP DATABASE` inside a quoted shell string not caught** (MEDIUM, fixed). Original
   regex required a leading whitespace boundary that did not exist inside quotes. Fixed by
   using a non-word boundary on the left.
4. **Ugrep rejecting `(^|\W)` in ERE** (MEDIUM, fixed). Claude Code's `grep` wrapper
   resolves to ugrep on some platforms; ugrep rejects empty alternatives. Fixed by
   dropping the boundary and matching the FAIL token alone.
5. **`local status` interaction with zsh in interactive shells** (LOW, fixed). Renamed the
   helper-internal variable to `porcelain` to avoid any chance of colliding with zsh's
   reserved word in test contexts.

## Defects found by independent audit and fixed

All four were in `protect-destructive-commands.sh`. Final state: 20/20 cases PASS in
`/tmp/test_drop.py`.

1. **D1 (HIGH): rm regex over-blocks `./anything`** — fixed by tightening the boundary.
   The new regex matches only when the rm target is *the directory itself* (`/`, `.`,
   `..`, `~`, `~user`, `$HOME`) followed by space/semicolon/end, not when it's a
   specific path inside that directory (`./build`, `.git`, `build/`).
2. **D2 (HIGH): `--force-with-lease` blocked when targeting main** — fixed by splitting
   the regex into two: one matches `--force-with-lease` (allowed), the other matches
   `--force` not followed by `-with-lease` (blocked on protected branches). The block
   requires *both* `--force` matches AND `--force-with-lease` does not match.
3. **D3 (MEDIUM): shell-metacharacter bypass** — not actually a defect. The new rm regex
   uses a trailing `(space | ; | end)` boundary, so `rm -rf . ; echo done` and
   `rm  -rf  .` both still match. Verified PASS.
4. **D4 (MEDIUM): `~user` under-detected** — fixed by replacing the literal `~` token in
   the regex with `~[^/[:space:]]*` which matches any tilde-prefixed path including
   `~root`, `~bob`, and bare `~`.

## Known limitations

- **Hook sees the bash command text, not parsed AST.** Strings that contain dangerous
  patterns inside quoted arguments will be matched. Documented above.
- **Transcript-path validation is by tail-read only.** If a subagent's structured handoff
  is delivered as a final message outside the transcript, the hook would not see it. In
  practice Claude Code's transcript captures the agent's final assistant message in the
  last lines, so this works.
- **No automatic test runs from TaskCompleted.** The hook is fast (jq + grep on small
  files); running `pnpm test:unit` from inside a hook would be too slow. Real test
  execution belongs at capability close, per `.agents/rules/testing.md`.
- **Force-push detection only catches `--force`/`-f` (not bare `git push` then local
  reset).** Local-history rewrites are not in scope; we block the wire-level push, not the
  local action.

## Recommended future hooks (not implemented)

- `PreCompact`: write a `work/handoffs/` note before context compaction. Deferred until
  there is an actual compaction incident.
- `PostToolUse` (very limited scope): a sub-100ms check for accidental secret writes. The
  `protect-destructive-commands` and `protect-root-pollution` hooks cover the higher-value
  cases already.
- `TaskCreated`: cross-check a newly proposed task against the capability ledger for an
  existing CAP-NNN before the agent starts. Useful when many capabilities are open; with
  the current WIP limit of one active capability, the orchestrator already enforces this
  manually.
- `TeammateIdle`: not in current Claude Code event set; revisit if a teammate model is
  adopted.

`Stop`, `PostToolUse` (general), `PostCompact`, and `TaskCreated` were explicitly rejected
in the spec for performance or churn reasons.