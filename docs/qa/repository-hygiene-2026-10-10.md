# Repository consistency and sensitive-information review — 2026-10-10

Scope: canonical repository source and local Git history, based on `9001d2c`.
This is repository maintenance evidence, not a new staging/production deployment.

## Documentation outcome

README, agent guidance, current ledger and execution plan now agree on self-hosted
D1 session authentication, admin-created accounts, satnaing/shadcn-admin, R2 editor
storage, system upload limits, bilingual error codes and focused staging acceptance.
Old Better Auth, shadcn-admin-kit and recovery proposals are explicitly historical.
Module/public-interface policy has one owning table. API exceptions distinguish
JSON bodies, raw uploads and provider-authenticated webhooks. Encryption rotation
and overlapping webhook rotation are not represented as delivered guarantees.

Personal absolute checkout paths and broken local links were corrected. Dated
historical evidence, upstream attribution and legacy commit identities remain.
The comprehensive acceptance catalog, additional provider work and production
cutover/data import still have separate acceptance boundaries.

## Sensitive-information evidence

- Gitleaks v8.30.1, official binary checksum verified: current reviewed files and
  all locally reachable Git history, including the legacy backup, scanned.
  The initial history scan processed 365 commit diffs and approximately 21.91 MB
  of content; after the two maintenance commits, it processed 367 diffs and
  approximately 21.98 MB. Empty diffs do not add scanned file content. Commit
  messages were also scanned separately with zero findings.
- Initial default-rule hits: 21 current-file hits and 32 history hits, all reviewed
  as synthetic test/mock literals or public development-only configuration.
  Exact value **and** exact fixture path exceptions apply only to their rule;
  tests/docs are not excluded wholesale. Reviewed scans return zero findings.
- Negative checks placed new synthetic credential-shaped strings in an existing
  allowlisted fixture path. Both generic API-key and GitHub token rules rejected
  them, demonstrating that the fixture exception does not hide unrelated values.
- Compared 18 available local deployment/password/session credential values
  privately against 4,499 reachable blob/commit objects: zero matches. A separate
  repeated-character local test key matched its known public fixture and was
  classified separately. No values or raw scan reports are published.
- No complete live editor download capability URL was found in those objects.
  Documentation uses repository-relative paths; private `.tmp`, environment
  files, secret recovery, logs and personal Claude configuration stay ignored.
- The new CI scan checks fetched history with redacted output and uploads no report.

These checks establish their stated scope. Pattern scanning cannot prove the
absence of every possible secret, validate credentials against providers, or
remove private copies/forks. No actual deployed credential leak requiring
rotation or shared-history purge was identified.

## Validation

`pnpm verify` passed: doctor 14/14, generated bindings, ESLint, TypeScript,
build and 2,217 tests (1,263 unit/Web/contracts/scripts, 932 Worker,
22 migration fixtures). Three new hook tests cover allowed/rejected command
privacy and 0700/0600 log permissions. Hook syntax checks and local Markdown link
targets passed; `git diff --check` passed. Documentation edits after this run do
not change runtime behavior. This review used a main-session self-check; no
independent agent or new browser/provider acceptance was run.
