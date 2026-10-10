#!/usr/bin/env bash
# subagent-start-context.sh — SubagentStart hook.
# Injects a small set of repository-level guardrails into every specialised subagent.
# Role-specific reminders are appended when the agent_type is recognisable. Never blocks.

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"

input="$(cat || true)"
if [ -z "${input}" ]; then
  exit 0
fi

# agent_type is the only field we care about. Different Claude Code versions have placed
# it at the top level or under a "subagent" envelope; the jq fallbacks cover both.
agent_type="$(printf '%s' "${input}" | jq -r '
  (.agent_type // .subagent_type // .subagent.agent_type // .type // "unknown")
' 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "unknown")"

hook_log "subagent-start" "type='${agent_type}'"

# Common guardrails: short, plain, sourced from .claude/rules and CLAUDE.md. We do NOT
# re-state the full rule set — that is the orchestrator's job when it dispatches the
# subagent, and re-stating it here would invite drift.
common=$'Repository rules are authoritative. Read CLAUDE.md and .claude/rules/ before any work.\n'
common+=$'Do not redesign unrelated architecture. Do not modify files outside your assigned scope.\n'
common+=$'Do not create unmanaged documentation at the repository root. Use work/ or .tmp/.\n'
common+=$'Business truth (docs/rebuild/02-business-discovery/) and the target architecture (docs/rebuild/05-target-architecture/) take precedence over legacy implementation.\n'
common+=$'Return a structured handoff when finished — the format is in .claude/agents/<role>.md.'

# Per-role appendix. We only emit role-specific text when the agent_type unambiguously
# identifies the role. `general-purpose` is ambiguous: the Main Session uses it for
# implementer, qa-reviewer, security-reviewer, frontend-reviewer, and (fallback)
# investigator / architecture-reviewer. Injecting the wrong role brief biases the
# subagent, so we deliberately omit it. Each agent's role file at .claude/agents/<role>.md
# already contains the full role-specific guidance; the agent reads that on launch.
case "${agent_type}" in
  implementer)
    role_specific=$'\nRole — implementer:\n'
    role_specific+=$'Implement only the assigned capability scope.\n'
    role_specific+=$'Add tests for every business rule you implement; name tests after the R-* rule ID.\n'
    role_specific+=$'Report exact changed file paths in the handoff. Do not self-approve completion.\n'
    ;;
  *code-reviewer*|code-reviewer|ts-reviewer|typescript-code-reviewer)
    role_specific=$'\nRole — code reviewer:\n'
    role_specific+=$'Review independently. You did not write this code; do not assume it is correct.\n'
    role_specific+=$'Construct the failure scenario before reporting a finding. No finding without a concrete failure.\n'
    role_specific+=$'Severity: BLOCKER / HIGH / MEDIUM / LOW. Anchor every finding at file:line.\n'
    ;;
  *architect*|web-architect|plan)
    role_specific=$'\nRole — architecture reviewer / planner:\n'
    role_specific+=$'Verify dependency direction against .claude/rules/architecture.md; every new edge must be in the allowed-dependency table.\n'
    role_specific+=$'Detect architectural drift and legacy anti-pattern recreation, not surface issues.\n'
    ;;
  *qa*|qa-reviewer)
    role_specific=$'\nRole — QA reviewer:\n'
    role_specific+=$'Validate business behaviour, not just implementation. Walk acceptance criteria one by one.\n'
    role_specific+=$'Challenge happy-path assumptions. For every state machine, verify the forbidden transitions are also rejected.\n'
    ;;
  *security*|security-reviewer)
    role_specific=$'\nRole — security reviewer:\n'
    role_specific+=$'Check IDOR, cross-tenant reach, mass assignment, idempotency-key reuse, and secret leakage.\n'
    role_specific+=$'Construct the attacker action before reporting. Read .claude/rules/security.md and the R-SECRET/R-AUTHZ/R-AUTH rule families.\n'
    ;;
  *investigator*|investigator)
    role_specific=$'\nRole — investigator:\n'
    role_specific+=$'You are read-only. Return findings with file:line evidence, never raw search output.\n'
    role_specific+=$'Do not reorganise files, do not edit code. The orchestrator decides what to do with your findings.\n'
    ;;
  *frontend*|frontend-reviewer)
    role_specific=$'\nRole — frontend reviewer:\n'
    role_specific+=$'For every screen, verify loading / empty / error / success states. Verify keyboard reachability and accessible names.\n'
    role_specific+=$'Do not allow store-as-event-bus patterns; server state invalidation is TanStack Query'\''s job.\n'
    ;;
  explore)
    role_specific=$'\nRole — read-only explorer:\n'
    role_specific+=$'You may only read. Do not propose changes inline; report findings in the handoff.\n'
    ;;
  *)
    role_specific=""
    ;;
esac

# SubagentStart is informational. Stdout becomes additional context for the subagent.
# We emit the common block + the role block, separated by a blank line.
printf '%s' "${common}"
if [ -n "${role_specific}" ]; then
  printf '%s' "${role_specific}"
fi
printf '\n'

exit 0
