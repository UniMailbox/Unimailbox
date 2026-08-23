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

# Unescape newlines before any grep. Transcript JSONL stores message text as one
# physical line with "\n" escape sequences, so a required heading like "## BLOCKER"
# never sits at a physical line start and the anchored section greps below could not
# match ANY final message — every reviewer stop was blocked regardless of content
# (observed 2026-08-23: 6 consecutive architecture-reviewer blocks, plus parallel
# code-reviewer blocks, zero recorded passes for any reviewer role). Splitting on the
# escape puts message-text headings at grep-visible line starts. This is a detection
# repair, not a weakening: every section heading below is still required.
#
# Second defect, same day: `printf '%s' "$body" | grep -q ...` under `set -o pipefail`
# returns 141 (SIGPIPE on the printf producer) whenever grep -q exits on an early
# match in a large body — a FOUND heading registered as missing. The greps below
# therefore feed grep via here-string instead of a pipeline: no producer, no SIGPIPE,
# and the exit status seen by `if !` is grep's alone.
if [ -n "${transcript_body}" ]; then
  transcript_body="$(printf '%s\n' "${transcript_body}" | awk '{ gsub(/\\n/, "\n"); print }')"
fi

# Detect role. Prefer the explicit `[role: X]` marker; fall back to a path reference.
# Order matters: more specific markers first.
role="unknown"
if [ -n "${transcript_body}" ]; then
  if grep -qE '\[role:[[:space:]]*implementer\]' <<<"${transcript_body}"; then
    role="implementer"
  elif grep -qE '\[role:[[:space:]]*code-reviewer\]' <<<"${transcript_body}"; then
    role="code-reviewer"
  elif grep -qE '\[role:[[:space:]]*architecture-reviewer\]' <<<"${transcript_body}"; then
    role="architecture-reviewer"
  elif grep -qE '\[role:[[:space:]]*qa-reviewer\]' <<<"${transcript_body}"; then
    role="qa-reviewer"
  elif grep -qE '\[role:[[:space:]]*security-reviewer\]' <<<"${transcript_body}"; then
    role="security-reviewer"
  elif grep -qE '\[role:[[:space:]]*frontend-reviewer\]' <<<"${transcript_body}"; then
    role="frontend-reviewer"
  elif grep -qE '\[role:[[:space:]]*investigator\]' <<<"${transcript_body}"; then
    role="investigator"
  elif grep -q '\.claude/agents/implementer\.md' <<<"${transcript_body}"; then
    role="implementer"
  elif grep -q '\.claude/agents/code-reviewer\.md' <<<"${transcript_body}"; then
    role="code-reviewer"
  elif grep -q '\.claude/agents/architecture-reviewer\.md' <<<"${transcript_body}"; then
    role="architecture-reviewer"
  elif grep -q '\.claude/agents/qa-reviewer\.md' <<<"${transcript_body}"; then
    role="qa-reviewer"
  elif grep -q '\.claude/agents/security-reviewer\.md' <<<"${transcript_body}"; then
    role="security-reviewer"
  elif grep -q '\.claude/agents/frontend-reviewer\.md' <<<"${transcript_body}"; then
    role="frontend-reviewer"
  elif grep -q '\.claude/agents/investigator\.md' <<<"${transcript_body}"; then
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
    if ! grep -qiE "^[[:space:]]*[*_#-]*[[:space:]]*Status:" <<<"${transcript_body}"; then
      missing+=("Status:")
    fi
    if ! grep -qiE "^[[:space:]]*[*_#-]*[[:space:]]*Files:" <<<"${transcript_body}"; then
      missing+=("Files:")
    fi
    if ! grep -qiE "^[[:space:]]*[*_#-]*[[:space:]]*(Tests:|Tests added:|Tests run:)" <<<"${transcript_body}"; then
      missing+=("Tests: (or Tests added: / Tests run:)")
    fi
    ;;
  code-reviewer|architecture-reviewer|qa-reviewer|security-reviewer|frontend-reviewer)
    # All reviewers use the same severity-headed structure. An empty section is
    # legitimate; the heading itself is the requirement.
    for h in "BLOCKER" "HIGH" "MEDIUM" "LOW"; do
      if ! grep -qE "^[[:space:]]*##[[:space:]]+${h}" <<<"${transcript_body}"; then
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