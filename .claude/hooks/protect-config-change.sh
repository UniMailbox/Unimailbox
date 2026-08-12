#!/usr/bin/env bash
# protect-config-change.sh — ConfigChange hook.
# Emits a loud, structured log entry whenever a governance file is changed. The hook
# does not block: governance changes are legitimate, and the orchestrator's review is
# the real safeguard. What it does is make every such change visible, so a future audit
# can answer "what changed and when" without grepping the git log blind.

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"

input="$(cat || true)"
if [ -z "${input}" ]; then
  exit 0
fi

# ConfigChange payloads typically name the file that was changed. We try a few
# candidate field names; the log entry uses the first one that resolves.
file_path="$(printf '%s' "${input}" | jq -r '
  (.file_path // .path // .config_path // "")
' 2>/dev/null || echo "")"

# If we can't tell what changed, allow silently — but log that we couldn't tell, because
# that itself is suspicious.
if [ -z "${file_path}" ]; then
  hook_log "config-change" "no file_path in payload; allowing"
  exit 0
fi

# Match against the protected paths. The patterns are anchored at end so that
# `.claude/rules/old-thing.md.bak` does not match `.claude/rules/`.
case "${file_path}" in
  */.claude/settings.json|*/.claude/settings.local.json|*/CLAUDE.md)
    hook_log "config-change" "GOVERNANCE FILE MODIFIED: ${file_path}"
    printf 'NOTICE: governance file modified — %s\n' "${file_path}" >&2
    printf '  This is a permitted change but a material one. The orchestrator must review\n' >&2
    printf '  the diff before committing, per .claude/rules/agent-collaboration.md §Rules change policy.\n' >&2
    printf '  No automatic block; logged to .tmp/claude-hooks/hooks.log for audit.\n' >&2
    ;;
  */.claude/rules/*)
    hook_log "config-change" "RULE FILE MODIFIED: ${file_path}"
    printf 'NOTICE: rule file modified — %s\n' "${file_path}" >&2
    printf '  Rule edits must follow .claude/rules/agent-collaboration.md §Rules change policy.\n' >&2
    ;;
  */.claude/agents/*|*/.claude/skills/*|*/.claude/templates/*)
    hook_log "config-change" "AGENT/SKILL/TEMPLATE FILE MODIFIED: ${file_path}"
    printf 'NOTICE: agent/skill/template file modified — %s\n' "${file_path}" >&2
    printf '  Changes here reshape who the orchestrator delegates to and how. Review the diff\n' >&2
    printf '  alongside the next capability close.\n' >&2
    ;;
  */.claude/hooks/*)
    hook_log "config-change" "HOOK FILE MODIFIED: ${file_path}"
    printf 'NOTICE: hook file modified — %s\n' "${file_path}" >&2
    printf '  Hook edits should be reviewed alongside the next capability close.\n' >&2
    ;;
  *)
    # Unrelated config change; do not log, do not notify.
    exit 0
    ;;
esac

exit 0
