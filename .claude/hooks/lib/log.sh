# log.sh — minimal logging for hooks.
# Append-only, plain text, ISO 8601 timestamps, no secrets.
# Loaded with: source "$(dirname "${BASH_SOURCE[0]}")/lib/log.sh"

# Path resolution: this file lives at <repo>/.claude/hooks/lib/log.sh, so the repo root
# is four levels up. Falls back to PWD if that arithmetic fails (e.g. invoked outside
# a checkout, or via a symlink that the cd cannot resolve).
HOOK_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd 2>/dev/null || pwd)"
HOOK_LOG_DIR="${HOOK_REPO_ROOT}/.tmp/claude-hooks"
HOOK_LOG_FILE="${HOOK_LOG_DIR}/hooks.log"

# Create the log directory once. mkdir -p is idempotent; the || true keeps the hook from
# crashing if the filesystem is read-only or the path is wedged — we would rather log nothing
# than block the user's workflow.
hook_log_init() {
  mkdir -p "${HOOK_LOG_DIR}" 2>/dev/null || true
}

# hook_log <event> <message...>
# Writes one line: ISO 8601 UTC timestamp, hook name, event, message.
# The hook name is the basename of the calling script; this is how the log stays
# grep-able without each script having to thread its identity through.
hook_log() {
  hook_log_init
  local ts event
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown-time")"
  event="${1}"
  shift || true
  local hook_name
  hook_name="$(basename "${BASH_SOURCE[1]:-$0}" 2>/dev/null || echo "unknown")"
  # printf %q would over-quote; the message is operator-facing log text, not shell input.
  printf '%s %s %s %s\n' "${ts}" "${hook_name}" "${event}" "$*" \
    >> "${HOOK_LOG_FILE}" 2>/dev/null || true
}
