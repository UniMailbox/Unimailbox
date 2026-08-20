#!/usr/bin/env bash
# session-context.sh — SessionStart hook.
# Injects a small execution-state context block so a fresh session can orient without
# re-reading the whole repository. Never blocks. Degrades gracefully when state is missing.

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"
# shellcheck source=lib/project-state.sh
source "$(dirname "$0")/lib/project-state.sh"

hook_log "session-start" "begin"

# Collect state. Each accessor is a no-op on a half-built repository.
phase="$(ps_current_phase)"
recent="$(ps_recent_log)"
active="$(ps_active_workspace)"
ledger_active="$(ps_ledger_active_capability)"
next="$(ps_ledger_next_capability)"
drift="$(ps_state_drift)"
branch="$(ps_git_branch)"
dirty="$(ps_git_dirty)"

# Compose the context block. We deliberately use printf %s (no -e) so a phase title with
# backslashes cannot corrupt the output. The format mirrors the spec's example, with the
# additions this project actually has (recent log entry, git state).
{
  printf 'Repository execution state\n'
  printf '\n'
  if [ -n "${phase}" ]; then
    printf 'Current phase:\n%s\n' "${phase}"
  else
    printf 'Current phase:\n(unknown — capability ledger not found)\n'
  fi
  printf '\n'
  if [ -n "${active}" ]; then
    printf 'Active workspace:\nwork/active/%s/\n' "${active}"
  else
    printf 'Active workspace:\n(none — no work/active/<cap>/ directory)\n'
  fi
  if [ -n "${ledger_active}" ]; then
    printf '\nLedger active capability:\n%s\n' "${ledger_active}"
  fi
  if [ -n "${next}" ]; then
    printf '\nNext capability:\n%s\n' "${next}"
  fi
  if [ -n "${drift}" ]; then
    printf '\nSTATE DRIFT — fix before implementation:\n%s\n' "${drift}"
  fi
  if [ -n "${branch}" ]; then
    printf '\nGit:\nbranch %s%s\n' "${branch}" "${dirty:+ (${dirty})}"
  else
    printf '\nGit:\n(not a git repository)\n'
  fi
  if [ -n "${recent}" ]; then
    printf '\nMost recent implementation log entry:\n%s\n' "${recent}"
  fi
  printf '\nOrientation: see CLAUDE.md §State recovery — fresh session for the full procedure.\n'
  printf 'Authoritative status: docs/rebuild/capability-ledger.md; ordered work: docs/rebuild/execution-plan.md.\n'
} | tee >(cat >&2)

hook_log "session-start" "end phase='${phase}' active='${active}' branch='${branch}' drift='${drift}'"

# SessionStart is informational. Always exit 0 — a session that cannot start is worse than
# a session that starts with degraded context.
exit 0
