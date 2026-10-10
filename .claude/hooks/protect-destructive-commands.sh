#!/usr/bin/env bash
# protect-destructive-commands.sh — PreToolUse hook, matcher: Bash.
# Blocks high-confidence, irreversible shell operations. Deliberately narrow: the spec
# is explicit that overblocking (e.g. blocking every rm) is a defect. Each pattern below
# was chosen because it has a known incident shape and no plausible legitimate use in
# the ordinary development loop on this repository.

set -euo pipefail

# shellcheck source=lib/log.sh
source "$(dirname "$0")/lib/log.sh"

# Read the tool input from stdin. PreToolUse hooks receive JSON; we only need the command
# field, so a single jq call is sufficient and fast.
input="$(cat || true)"
if [ -z "${input}" ]; then
  hook_log "destructive-guard" "no input; allowing"
  exit 0
fi

command="$(printf '%s' "${input}" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")"
if [ -z "${command}" ]; then
  hook_log "destructive-guard" "could not extract command; allowing"
  exit 0
fi

# Normalise: collapse whitespace for matching, but keep the original command for the
# reason text. The collapse prevents trivial bypasses like "rm  -rf  /" or a leading
# newline.
norm="$(printf '%s' "${command}" | tr -s '[:space:]' ' ')"

block() {
  # The reason ends up in the model's context via the hook's stderr. Be specific: name
  # what was matched, not just "denied".
  hook_log "destructive-guard" "BLOCKED: $1 :: ${command}"
  printf 'BLOCKED by protect-destructive-commands: %s\n' "$1" >&2
  printf 'Command: %s\n' "${command}" >&2
  printf 'If this is intentional, narrow the command (e.g. `rm -rf ./build`, not `rm -rf .`) and re-run.\n' >&2
  exit 2
}

# --- Filesystem wipeout ---
# `rm -rf` of root (/), bare home (~), $HOME, current dir (.), parent dir (..), or any
# `~user` form. The pattern matches only when the target is *the directory itself* or
# an immediate glob of it (`rm -rf .`, `rm -rf /foo` is allowed because /foo is a
# specific path inside root, not root itself; `rm -rf ./build` is allowed because
# `./build` is a specific path inside current dir). The right-anchored boundary means
# `rm -rf build/` (no leading dot, no leading slash, no leading tilde) does not match.
if printf '%s' "${norm}" | grep -qE '(^|[^A-Za-z0-9_/.])rm[[:space:]]+(-[A-Za-z]*[rRfF][A-Za-z]*[[:space:]]+)+(/|~[^/[:space:]]*|\$HOME|\.\.?)([[:space:]];|$)'; then
  block "rm -rf of root, home, current/parent directory, or a ~user path"
fi

# --- Hard git history rewrites on the local tree ---
# `git reset --hard` is the canonical "throw away my work" command. `git clean -fdx`
# deletes untracked AND ignored files (the -x is the dangerous flag). Other clean modes
# (-fd, -f) are excluded on purpose: they are common during normal cleanup and have a
# clear "directories, no ignored" scope.
if printf '%s' "${norm}" | grep -qE '(^|[[:space:]])git[[:space:]]+reset[[:space:]]+--hard([[:space:]]|$)'; then
  block "git reset --hard is irreversible; use git restore or git stash instead"
fi
if printf '%s' "${norm}" | grep -qE '(^|[[:space:]])git[[:space:]]+clean[[:space:]]+-[A-Za-z]*f[A-Za-z]*x'; then
  block "git clean -fdx wipes ignored files too; use -f or -fd if you do not mean that"
fi

# --- Force-push to protected branches ---
# `--force-with-lease` is intentionally NOT blocked: it is the safe form of force-push,
# refusing to clobber upstream changes you have not seen. Only bare `--force` / `-f`
# targeting a protected branch is blocked. We split the check into two cases:
#   1. `--force` followed by `-with-lease` is never blocked.
#   2. `--force` (not followed by `-with-lease`) targeting a protected branch blocks.
# The negative-lookahead shape uses two separate patterns joined with OR.
force_pushed_to_protected() {
  printf '%s' "${1}" | grep -qE '(^|[[:space:]])git[[:space:]]+push[[:space:]]+[^;&|]*--force-with-lease([^;&|]|$)'
}
force_push_bare() {
  printf '%s' "${1}" | grep -qE '(^|[[:space:]])git[[:space:]]+push[[:space:]]+[^;&|]*--force([^;&|]*[[:space:]]+(origin[[:space:]]+)?(main|master|production)([[:space:]]|$))'
}
if force_push_bare "${norm}" && ! force_pushed_to_protected "${norm}"; then
  block "force-push to main / master / production is not allowed from a hook"
fi
# Bare `git push --force` (no target) would default to the current branch's upstream,
# which is normally a feature branch — but if the caller is on main it would force-push
# main. We block that case explicitly: if origin is omitted AND --force/-f is present
# AND the current branch is one of the protected names, block. This needs the current
# branch, so query git.
if printf '%s' "${norm}" | grep -qE '(^|[[:space:]])git[[:space:]]+push[[:space:]]+[^;&|]*(--force|-f)([[:space:]]|$)'; then
  cur_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
  case "${cur_branch}" in
    main|master|production)
      block "force-push while on a protected branch (${cur_branch}) is not allowed"
      ;;
  esac
fi

# --- Database schema destruction ---
# Plain `DROP DATABASE` / `DROP SCHEMA` is never part of routine work on this project;
# the legacy D1 database is only ever altered through numbered migrations under
# `migrations/`, with a paired `.verify.sql`. If you really need to drop something, scope
# it to a specific table or use a migration.
#
# The pattern uses a non-word boundary on the left so that `wrangler d1 execute --command
# "DROP DATABASE foo"` is caught (the literal DROP is inside a quoted string, not preceded
# by a shell space). Word boundaries on the right require whitespace or punctuation after
# the keyword, so `DROP TABLE` would not match here — that is caught by the table-specific
# rules if/when we add them.
if printf '%s' "${norm}" | grep -qiE '(^|[^A-Za-z0-9_])drop[[:space:]]+(database|schema)([^A-Za-z0-9_]|$)'; then
  block "DROP DATABASE / DROP SCHEMA — use a numbered migration under migrations/ instead"
fi

# Allow.
hook_log "destructive-guard" "allowed: ${command}"
exit 0
