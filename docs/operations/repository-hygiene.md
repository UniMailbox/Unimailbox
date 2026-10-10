# Public repository and commit hygiene

This repository is public. Documentation must describe behavior and evidence
without containing usable credentials or private user/mail data.

## Before committing

1. Inspect branch, upstream, working tree and index; preserve unrelated changes.
2. Group commits by reviewable intent. Keep documentation consistency separate
   from behavioral security/tooling changes. Use Conventional Commits and
   `JohnJiang <johnjiang@leanda.tech>` for author and committer.
3. Stage named, reviewed paths. Never include `.tmp`, `.dev.vars`, `.env`, personal
   Claude settings/memory, secret-recovery files, raw logs or database exports.
4. Check that README, current ledger state, design decisions and agent conventions
   agree. Keep old plans and acceptance reports dated and explicitly historical.
5. Run appropriate gates and the secret checks below. Record scope and limitations,
   rather than claiming that a scanner proves absence of every possible secret.

Commit identity already normalized in the rebuilt history stays intact. Published
legacy authors and the repository integration commit are preserved; routine
documentation cleanup does not require rewriting shared history.

## Sensitive information

Never publish real passwords, initial passwords, tokens, API/SMTP keys, private
keys, session cookies, live recipient download capabilities, message bodies or
private recovery artifacts. Prefer repository-relative paths over personal home
directories. Use reserved example domains and explicitly synthetic test values.

Cloudflare account/resource IDs, queue names and the public staging hostname are
operational configuration, not authentication credentials. Public commit identity,
upstream attribution and licenses are intentional metadata. Keep required
deployment configuration; avoid copying account-specific recovery paths into
general instructions.

`wrangler.dev.jsonc` and `wrangler.test.jsonc` contain public local-only fixtures.
They must never be used as deployed secrets. The release tooling uses explicit
environment configurations and Cloudflare secret bindings instead.

## Secret scans

Use [Gitleaks](https://github.com/gitleaks/gitleaks) v8.30.1. CI downloads a
checksum-pinned binary and scans all fetched history, including retained legacy
history. Output is redacted and no scan artifact is uploaded.

```sh
# All locally reachable history; fetch intended remote refs before an audit.
gitleaks git --log-opts=--all --config .gitleaks.toml --redact --no-banner

# Staged, not-yet-committed content, including newly added documents/config.
gitleaks git --pre-commit --staged --config .gitleaks.toml --redact --no-banner
```

For a working-file scan, export only the reviewed files to ignored scratch and
use `gitleaks dir`; do not scan/upload private scratch as a public artifact.
Check commit messages separately when auditing history. Compare known local
deployment credentials privately against Git objects when available, without
printing those values.

`.gitleaks.toml` extends the upstream default rules. Reviewed synthetic fixtures
are allowed only for the exact value **and** exact fixture path under the relevant
rule. Never exclude whole test/doc trees or an entire commit to hide a finding.
New credentials in an existing fixture file must still fail the scan.

## Findings and cleanup

Classify a hit from its usage: a hardcoded HTTP-mock fixture differs from a
credential used by staging. Report an actual credential's kind and file/commit,
never its value. Rotate or revoke it first, then coordinate removal from current
files and published history. History cleanup needs explicit authorization and
cannot remove copies held by forks or other checkouts.

Claude hook logs are local private scratch. Current hooks omit raw shell commands;
older logs may contain command arguments. Review or dispose of those privately.
No test, CI pass or scan establishes production cutover or data-import acceptance.
