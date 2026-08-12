#!/usr/bin/env bash
# protect-root-pollution.sh — PreToolUse hook, matcher: Write|Edit|MultiEdit.
# Blocks writes to repository root that look like ad-hoc working documents. The governance
# rule (`.claude/rules/documentation.md` §Root directory) is: PLAN.md, NOTES.md, TODO*.md,
# RESULT.md, ANALYSIS.md, REVIEW*.md, DEBUG.txt, SUMMARY.md, and similar names do not belong
# at root. Use work/active, work/investigations, work/reviews, or .tmp/.

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"

input="$(cat || true)"
if [ -z "${input}" ]; then
  exit 0
fi

# Different tools name the path field differently. Pull whichever is present.
file_path="$(printf '%s' "${input}" | jq -r '
  (.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // "")
' 2>/dev/null || echo "")"
if [ -z "${file_path}" ]; then
  exit 0
fi

# Resolve the repository root the same way the other hooks do.
repo_root="$(cd "$(dirname "$0")/../.." && pwd 2>/dev/null || pwd)"

# We only care about the root. If the file is anywhere else, allow.
# Compute the parent directory of the file. If it equals the repo root, it is at root.
parent="$(cd "$(dirname "${file_path}")" 2>/dev/null && pwd || echo "")"
if [ -z "${parent}" ] || [ "${parent}" != "${repo_root}" ]; then
  exit 0
fi

base="$(basename "${file_path}")"
# Lowercase compare for the pattern check.
base_lc="$(printf '%s' "${base}" | tr '[:upper:]' '[:lower:]')"

# Forbidden patterns. Tighter than the prose rule: the prose says "and anything similar"
# but the spec for THIS hook is "high-confidence protection, low false-positive rate", so
# we restrict to the named cases plus a small set of obvious variants.
forbidden='^(plan|notes|debug|analysis|findings|summary|result)([._-].*)?\.md$|^todo(_.*)?\.md$|^review(_.*)?\.md$|^(debug|trace|stdout|stderr)\.txt$'

if printf '%s' "${base_lc}" | grep -qiE "${forbidden}"; then
  hook_log "root-pollution" "BLOCKED: ${file_path}"
  printf 'BLOCKED by protect-root-pollution: %s would create %s at the repository root.\n' \
    "$(printf '%s' "${input}" | jq -r '.tool_name // "Write"')" "${base}" >&2
  printf 'Use one of these instead:\n' >&2
  printf '  work/active/CAP-NNN-slug/     — capability in flight\n' >&2
  printf '  work/investigations/INV-NNN-*.md  — technical investigation\n' >&2
  printf '  work/reviews/CAP-NNN-*-review.md — review report\n' >&2
  printf '  .tmp/                          — disposable scratch (gitignored)\n' >&2
  printf 'If the file is genuinely permanent, the existing allowlist (CLAUDE.md, CLAUDE.md, README.md, etc.) applies; add a permanent file only by editing the allowlist via the rules-change procedure.\n' >&2
  exit 2
fi

# Allow.
exit 0
