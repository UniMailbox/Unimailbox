# project-state.sh — read-only accessors for the repository's execution state.
# Loaded with: source "$(dirname "${BASH_SOURCE[0]}")/lib/project-state.sh"
# All functions are safe to call on a half-built repository; they degrade to empty strings
# rather than failing, so SessionStart and other informational hooks can use them.

# Resolve the repository root from the script location, falling back to PWD. This file
# lives at <repo>/.claude/hooks/lib/project-state.sh, so the repo root is four levels up.
# Duplicated from log.sh so the lib files are source-order independent.
ps_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd || pwd
}

# ps_git_branch — short branch name, or empty if not a git repo OR no commits yet.
# `git rev-parse --abbrev-ref HEAD` returns exit 128 when the repo has zero commits;
# `|| true` swallows that under `set -euo pipefail` so a freshly-`git init`'-ed repo
# does not abort the calling script.
ps_git_branch() {
  git -C "$(ps_repo_root)" rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

# ps_git_dirty — emits a short marker if the working tree has uncommitted changes.
# Returns just the marker, on stdout. Empty string if clean. Same exit-code defensive
# pattern as ps_git_branch: `git status` returns 128 on a corrupt repo.
ps_git_dirty() {
  local porcelain
  porcelain="$(git -C "$(ps_repo_root)" status --porcelain 2>/dev/null | head -1 || true)"
  if [ -n "${porcelain}" ]; then
    printf 'uncommitted'
  fi
}

# ps_active_workspace — first entry under work/active/ (excluding .gitkeep), or empty.
# Capability workspaces are one-directory-per-CAP; only one is allowed at a time, so first
# match is sufficient and faster than a full directory walk.
ps_active_workspace() {
  local repo
  repo="$(ps_repo_root)"
  local d
  for d in "${repo}/work/active"/*/; do
    [ -d "${d}" ] || continue
    local base
    base="$(basename "${d}")"
    [ "${base}" = ".gitkeep" ] && continue
    printf '%s' "${base}"
    return
  done
}

# ps_active_workspace_count — number of capability workspaces. The normal value is 0 or 1.
ps_active_workspace_count() {
  local repo count d
  repo="$(ps_repo_root)"
  count=0
  for d in "${repo}/work/active"/*/; do
    [ -d "${d}" ] || continue
    [ "$(basename "${d}")" = ".gitkeep" ] && continue
    count=$(( count + 1 ))
  done
  printf '%d' "${count}"
}

# ps_workspace_cap_id — CAP-NNN parsed from the active workspace name.
ps_workspace_cap_id() {
  ps_cap_id_from_text "$(ps_active_workspace)"
}

# ps_current_phase — value of the **Phase** row in the ledger's Current state table.
# Do not use the first "## Phase" heading: that is permanently Phase 0 and caused the
# SessionStart hook to report stale state while Phase 2 was active.
ps_current_phase() {
  local repo
  repo="$(ps_repo_root)"
  local ledger="${repo}/docs/rebuild/capability-ledger.md"
  [ -f "${ledger}" ] || return 0
  awk -F'|' '
    /^\| \*\*Phase\*\* \|/ {
      value = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "${ledger}" 2>/dev/null
}

# ps_ledger_state_value <label> — read one row from the ledger's Current state table.
ps_ledger_state_value() {
  local label="$1" repo ledger
  repo="$(ps_repo_root)"
  ledger="${repo}/docs/rebuild/capability-ledger.md"
  [ -f "${ledger}" ] || return 0
  awk -F'|' -v label="${label}" '
    {
      key = $2
      gsub(/\*/, "", key)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == label) {
        value = $3
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
        exit
      }
    }
  ' "${ledger}" 2>/dev/null
}

ps_ledger_active_capability() {
  ps_ledger_state_value "Active capability"
}

ps_ledger_next_capability() {
  ps_ledger_state_value "Next capability"
}

ps_ledger_active_cap_id() {
  ps_cap_id_from_text "$(ps_ledger_active_capability)"
}

# ps_state_drift — emits semicolon-separated drift findings, or nothing when state agrees.
ps_state_drift() {
  local count workspace_cap ledger_cap drift
  count="$(ps_active_workspace_count)"
  workspace_cap="$(ps_workspace_cap_id)"
  ledger_cap="$(ps_ledger_active_cap_id)"
  drift=""

  if [ "${count}" -gt 1 ]; then
    drift="${count} active workspaces violate the default WIP limit"
  fi
  if [ -n "${workspace_cap}" ] && [ -z "${ledger_cap}" ]; then
    drift="${drift}${drift:+; }workspace ${workspace_cap} exists but ledger has no CAP active"
  elif [ -n "${workspace_cap}" ] && [ -n "${ledger_cap}" ] && [ "${workspace_cap}" != "${ledger_cap}" ]; then
    drift="${drift}${drift:+; }workspace ${workspace_cap} disagrees with ledger ${ledger_cap}"
  elif [ -z "${workspace_cap}" ] && [ -n "${ledger_cap}" ]; then
    drift="${drift}${drift:+; }ledger says ${ledger_cap} is active but no matching workspace exists"
  fi

  printf '%s' "${drift}"
}

# ps_recent_log — the first heading line of the most recent implementation-log entry.
# Implementation log is append-only, newest-first, so the first "## " after the intro is it.
ps_recent_log() {
  local repo
  repo="$(ps_repo_root)"
  local log="${repo}/docs/rebuild/implementation-log.md"
  [ -f "${log}" ] || return 0
  # The first ## heading after a horizontal rule --- is the most recent entry.
  awk 'BEGIN { seen_rule = 0 } /^---$/ { seen_rule = 1; next } seen_rule && /^## / { sub(/^## /, ""); print; exit }' "${log}" 2>/dev/null
}

# ps_cap_id_from_text <text> — extract the first CAP-NNN token, or empty.
# Used by TaskCompleted to detect "this completion concerns CAP-014". Must be safe under
# `set -euo pipefail` even when no match is found; the trailing `|| true` neutralises
# grep's exit-1 on no-match, which pipefail would otherwise propagate.
ps_cap_id_from_text() {
  printf '%s' "$1" | grep -oE 'CAP-[0-9]+' 2>/dev/null | head -1 || true
}

# ps_review_finding_count <cap-id> <severity> — number of numbered findings under a section
# in work/reviews/${cap}-*.md. Reviewer headings look like "## BLOCKER", "## HIGH",
# "## MEDIUM", "## LOW" (per the review template). A "## BLOCKER" with no "### BLOCKERN"
# entries underneath is treated as zero findings (clean section, not absent).
ps_review_finding_count() {
  local cap="$1" severity="$2"
  local repo
  repo="$(ps_repo_root)"
  local total=0
  local f count
  for f in "${repo}/work/reviews/${cap}-"*.md; do
    [ -f "${f}" ] || continue
    count="$(awk -v sev="${severity}" '
      $0 ~ "^## " sev "[^A-Za-z0-9]*$" { in_sec = 1; next }
      /^## [A-Z]/ { in_sec = 0 }
      in_sec && /^### [A-Z][0-9]/ { count++ }
      END { print count + 0 }
    ' "${f}")"
    total=$(( total + count ))
  done
  printf '%d' "${total}"
}
