#!/usr/bin/env bash
# validate-task-completed.sh — TaskCompleted hook.
# The hardest hook to get right: it is the project's main quality gate, but it runs in a
# context where we cannot reliably inspect the agent's internal state. The principle is
# "high-confidence, low-false-positive": only block on checks we can verify mechanically,
# and only on the task types where blocking actually adds safety.
#
# Block conditions (any one fails the gate):
#   1. The task description references a CAP-NNN capability being marked done, AND
#      work/reviews/ for that capability has unresolved BLOCKER or HIGH findings.
#   2. The task description explicitly says "tests pass" or "all green" but a recent
#      task transcript contains a FAIL/TEST FAIL line in the last 50 lines. (Best-effort
#      heuristic; not always accurate but catches the common "report green when the
#      suite is red" error.)
#
# We do NOT block on:
#   - Investigation / docs tasks that don't claim to have run tests.
#   - Implementation tasks with no CAP-NNN reference and no "tests pass" claim.
#   - Tasks where the orchestrator explicitly overrides (out of scope for v1).

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"
# shellcheck source=lib/project-state.sh
source "$(dirname "$0")/lib/project-state.sh"

input="$(cat || true)"
if [ -z "${input}" ]; then
  exit 0
fi

# TaskCompleted payloads vary. Common fields: task_id, status, result, content, message.
# We pull as many candidates as we can and concatenate them, so any of them naming a
# CAP-NNN or a green-claim is caught.
#
# Production payloads from Claude Code are valid JSON with proper escapes; if jq fails
# to parse, we treat that as a malformed payload and exit cleanly (allow) — the
# orchestrator's own review is the real safeguard for malformed events.
text=""
if extracted="$(printf '%s' "${input}" | jq -r '
  [
    .task_description // "",
    .description // "",
    .status // "",
    (.result // "" | tostring),
    (.content // "" | tostring),
    (.message // "" | tostring)
  ] | join("\n")
' 2>/dev/null)"; then
  text="${extracted}"
fi
text="${text-}"

if [ -z "${text}" ]; then
  exit 0
fi

# Detect "this is a CAP closure" by the presence of a CAP-NNN token. If absent, this is
# not a capability-completion event, and the gate does not apply.
cap_id="$(ps_cap_id_from_text "${text}")"

# Detect "tests pass" / "all green" / "build green" claims.
green_claim=0
if printf '%s' "${text}" | grep -qiE '(all[[:space:]]+tests[[:space:]]+pass|tests[[:space:]]+pass|build[[:space:]]+green|all[[:space:]]+green|typecheck[[:space:]]+pass|lint[[:space:]]+pass)'; then
  green_claim=1
fi

# Detect "DONE / COMPLETE" claims.
done_claim=0
if printf '%s' "${text}" | grep -qiE '(\bDONE\b|\bCOMPLETE\b)'; then
  done_claim=1
fi

# No CAP and no green claim: this is not an implementation-completion event. Allow.
if [ -z "${cap_id}" ] && [ "${green_claim}" -eq 0 ]; then
  hook_log "task-completed" "non-completion event; allowing"
  exit 0
fi

block_reasons=()

# Gate 1: CAP closure with open review findings.
if [ -n "${cap_id}" ]; then
  blockers="$(ps_review_finding_count "${cap_id}" "BLOCKER")"
  highs="$(ps_review_finding_count "${cap_id}" "HIGH")"
  if [ "${blockers}" -gt 0 ] || [ "${highs}" -gt 0 ]; then
    block_reasons+=("CAP ${cap_id} has ${blockers} BLOCKER and ${highs} HIGH open in work/reviews/")
  fi
fi

# Gate 2: green claim but the input itself contains a FAIL line. (Catches the "report
# green when the suite is red" failure mode without running anything.) The regex is
# deliberately simple: a token `FAIL`, or the phrase `tests failed`. Anchoring with
# `(^|\W)` failed on the ugrep build that Claude Code's `grep` wrapper uses; ugrep is
# stricter about empty alternatives in ERE. The token alone is signal enough.
if [ "${green_claim}" -eq 1 ]; then
  if printf '%s' "${text}" | grep -qE '(FAIL|tests?[[:space:]]+failed|test[[:space:]]+failures?)'; then
    block_reasons+=("task claims success but the message contains a FAIL line; investigate before closing")
  fi
fi

if [ "${#block_reasons[@]}" -gt 0 ]; then
  hook_log "task-completed" "BLOCKED: ${block_reasons[*]}"
  printf 'BLOCKED by validate-task-completed:\n' >&2
  for r in "${block_reasons[@]}"; do
    printf '  - %s\n' "${r}" >&2
  done
  if [ -n "${cap_id}" ]; then
    printf '\nRequired next action:\n' >&2
    printf '  - Resolve every BLOCKER and HIGH in work/reviews/%s-*.md\n' "${cap_id}" >&2
    printf '  - Re-run the relevant quality gates (pnpm test:unit / test:worker / typecheck)\n' >&2
    printf '  - Update the capability ledger and implementation log\n' >&2
    printf '  - Then mark the task complete\n' >&2
  fi
  exit 2
fi

hook_log "task-completed" "ok cap='${cap_id}' green=${green_claim} done=${done_claim}"
exit 0
