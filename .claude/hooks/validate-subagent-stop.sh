#!/usr/bin/env bash
# validate-subagent-stop.sh — SubagentStop hook.
# Refuses to let a subagent finish without a structured handoff that matches its role.
# Roles are detected from the transcript (not from `agent_type` alone), because the
# project launches implementer / qa-reviewer / security-reviewer / frontend-reviewer /
# architecture-reviewer / investigator all via `general-purpose` and the only signal of
# which role the subagent is acting as is in its system prompt body.
#
# Detection convention (set by the Main Session when dispatching):
#   "[role: <role-name>]" appears in the prompt body, where <role-name> is one of:
#     implementer, investigator, architecture-reviewer, code-reviewer,
#     qa-reviewer, security-reviewer, frontend-reviewer
# Fallback: grep the transcript for ".claude/agents/<role>.md" references.
# If neither is found, allow (fail-open) and log the gap.

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"

input="$(cat || true)"
if [ -z "${input}" ]; then
  exit 0
fi

agent_type="$(printf '%s' "${input}" | jq -r '
  (.agent_type // .subagent_type // .subagent.agent_type // "unknown")
' 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "unknown")"

transcript="$(printf '%s' "${input}" | jq -r '
  (.agent_transcript_path // .transcript_path // .subagent.transcript_path // "")
' 2>/dev/null || echo "")"

# Read the transcript tail. The handoff lives in the final messages; 400 lines is
# enough to capture the agent's role marker (in the prompt) plus the structured
# report (in the response). Reading more than the tail is unnecessary work on every
# SubagentStop fire.
transcript_body=""
if [ -n "${transcript}" ] && [ -r "${transcript}" ]; then
  transcript_body="$(tail -n 400 "${transcript}" 2>/dev/null || echo "")"
fi

# Detect role. Prefer the explicit `[role: X]` marker; fall back to a path reference.
# Order matters: more specific markers first.
role="unknown"
if [ -n "${transcript_body}" ]; then
  if printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*implementer\]'; then
    role="implementer"
  elif printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*code-reviewer\]'; then
    role="code-reviewer"
  elif printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*architecture-reviewer\]'; then
    role="architecture-reviewer"
  elif printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*qa-reviewer\]'; then
    role="qa-reviewer"
  elif printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*security-reviewer\]'; then
    role="security-reviewer"
  elif printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*frontend-reviewer\]'; then
    role="frontend-reviewer"
  elif printf '%s' "${transcript_body}" | grep -qE '\[role:[[:space:]]*investigator\]'; then
    role="investigator"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/implementer\.md'; then
    role="implementer"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/code-reviewer\.md'; then
    role="code-reviewer"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/architecture-reviewer\.md'; then
    role="architecture-reviewer"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/qa-reviewer\.md'; then
    role="qa-reviewer"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/security-reviewer\.md'; then
    role="security-reviewer"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/frontend-reviewer\.md'; then
    role="frontend-reviewer"
  elif printf '%s' "${transcript_body}" | grep -q '\.claude/agents/investigator\.md'; then
    role="investigator"
  fi
fi

# If we still don't know the role, fall back to the agent_type. Some agent types are
# inherently role-coded (Explore is always investigator-shaped; web-architect is the
# architecture reviewer).
if [ "${role}" = "unknown" ]; then
  case "${agent_type}" in
    explore|investigator|claude-code-guide)
      role="investigator"
      ;;
    web-architect|plan)
      role="architecture-reviewer"
      ;;
    typescript-code-reviewer|ts-reviewer)
      role="code-reviewer"
      ;;
    code-reviewer)
      role="code-reviewer"
      ;;
    security-reviewer)
      role="security-reviewer"
      ;;
    qa-reviewer)
      role="qa-reviewer"
      ;;
    frontend-reviewer)
      role="frontend-reviewer"
      ;;
    implementer)
      role="implementer"
      ;;
    *)
      # Truly unknown: no opinion, allow. The orchestrator's review is the safeguard.
      hook_log "subagent-stop" "unknown role type='${agent_type}'; allowing"
      exit 0
      ;;
  esac
fi

# Investigator has no required handoff format.
if [ "${role}" = "investigator" ]; then
  hook_log "subagent-stop" "ok role='${role}' type='${agent_type}' (no format check)"
  exit 0
fi

# No transcript body: cannot validate. Fail open and log.
if [ -z "${transcript_body}" ]; then
  hook_log "subagent-stop" "no transcript body for role='${role}' type='${agent_type}'; allowing"
  exit 0
fi

# Per-role validation. Each role produces a different structured report; the role
# files in .claude/agents/ are the source of truth for the format.
missing=()

case "${role}" in
  implementer)
    # The implementer format uses "Tests added:" and "Tests run:" rather than a bare
    # "Tests:" line. Match any of the three, case-insensitively.
    if ! printf '%s' "${transcript_body}" | grep -qiE "^[[:space:]]*[*_#-]*[[:space:]]*Status:"; then
      missing+=("Status:")
    fi
    if ! printf '%s' "${transcript_body}" | grep -qiE "^[[:space:]]*[*_#-]*[[:space:]]*Files:"; then
      missing+=("Files:")
    fi
    if ! printf '%s' "${transcript_body}" | grep -qiE "^[[:space:]]*[*_#-]*[[:space:]]*(Tests:|Tests added:|Tests run:)"; then
      missing+=("Tests: (or Tests added: / Tests run:)")
    fi
    ;;
  code-reviewer|architecture-reviewer|qa-reviewer|security-reviewer|frontend-reviewer)
    # All reviewers use the same severity-headed structure. An empty section is
    # legitimate; the heading itself is the requirement.
    for h in "BLOCKER" "HIGH" "MEDIUM" "LOW"; do
      if ! printf '%s' "${transcript_body}" | grep -qE "^[[:space:]]*##[[:space:]]+${h}"; then
        missing+=("## ${h}")
      fi
    done
    ;;
esac

if [ "${#missing[@]}" -gt 0 ]; then
  hook_log "subagent-stop" "BLOCKED role='${role}' type='${agent_type}' missing=${missing[*]}"
  printf 'BLOCKED by validate-subagent-stop: handoff is missing required sections for role %s:\n' "${role}" >&2
  for m in "${missing[@]}"; do
    printf '  - %s\n' "${m}" >&2
  done
  printf 'Add these sections to your final message and re-stop. See .claude/agents/%s.md for the format.\n' \
    "${role}.md" >&2
  exit 2
fi

hook_log "subagent-stop" "ok role='${role}' type='${agent_type}'"
exit 0