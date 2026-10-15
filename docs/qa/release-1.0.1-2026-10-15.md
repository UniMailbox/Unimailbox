# PR 48 review and 1.0.1 release — 2026-10-15

## Review and findings

Reviewed the full PR diff against origin/main, starting at head `ceff9e2` and
base `53d871d`. Scope includes MCP transport, direct D1 authentication, current
permissions/scopes, body/Origin/rate protections, audit and idempotency, personal
and administrator UI, identity cache/logout, relational heartbeat migration and
release workflows. Main-agent source/security self-review; no independent
reviewer or external mail-delivery test is claimed.

| Finding | Correction and regression evidence |
| --- | --- |
| P2: service-off UI hid all personal controls, preventing revocation until an administrator re-enabled MCP | Keep existing credential management/revocation available while disabled; issuance and Copy prompt stay gated. New UI test failed before the fix and passes after it. |
| P2: LIMIT 100 listing hid older credentials without any navigation, including still-active credentials | Owner-scoped 100-item keyset pages with an explicit Load more action. Worker regression first failed on the absent cursor; it now reaches/revokes an older live token after 100 archived records. Covers timestamp ties, insertions ahead of the cursor, foreign/missing anchors and disabled-service reads. |
| P2: adding nextCursor to the old strict response broke cached clients without a page reload | Negotiate the extra field only when new clients send X-MCP-Token-Pagination: 1. Preserve the exact legacy response otherwise. A live staging assertion reproduced the incompatible response on the initial candidate; eight UI/twelve focused Worker tests and TypeScript pass with the correction. |
| Release correctness: MCP initialize used a literal 1.0.0 | Use APPLICATION_VERSION and verify initialize metadata; bump product version to 1.0.1 before tagging. |

The Quick settings parent already keys the personal panel by user ID; that
existing account-change protection is retained instead of treating isolated
component prop changes as a reachable defect.

Existing live permission/revocation checks, namespace-separated idempotency,
content-free audit, atomic configuration writes and D1 failure/freshness guards
were retained. Pagination adds only explicit authenticated requests; there is no
new poll, scheduled task, migration, key or resource replacement.

## Validation

Focused Personal MCP UI: eight relevant tests passed (the redundant isolated
account-switch test was removed after confirming the parent already keys by user). Focused MCP Worker: eleven tests
passed before the final foreign-cursor/disabled-read assertions were added;
final full results follow below. TypeScript passed. Two initial red regressions
are recorded as expected failures. The first full gate stopped at a prohibited
non-null assertion introduced in pagination; that assertion was removed before
the complete rerun.

Current dependency audit: one critical, 13 high, 18 moderate and four low
advisories. Named packages are @vitest/mocker, brace-expansion, braces, dompurify,
esbuild, happy-dom, hono, js-yaml, seroval, sharp, source-map-js, vite and vitest.
No added MCP dependency is named. These are existing dependency advisories;
exploitability of the deployed bundle is not established by this audit.

The initial PR #48 candidate passed 2,414 tests: 1,374 non-Worker,
1,012 Worker and 28 migration fixtures. Exact-head GitHub Verify, CodeQL and
secret scans passed on `9ac32f1`; PR #48 merged as `316428d` with its merge tree
checked equal to the reviewed head.

The compatibility follow-up PR [#49](https://github.com/UniMailbox/Unimailbox/pull/49)
added a Worker regression and passed the complete local gate: **2,415 tests**
(1,374 non-Worker, 1,013 Worker, 28 migration fixtures), doctor 14/14,
generated bindings, lint, TypeScript and builds. Both exact-head Verify runs,
CodeQL and secret scans passed on `a0590a5`. The final merge `b4b7ca3` has the
same tree as that reviewed head, and all main checks passed. Both final staging
and production preparations repeated the complete 2,415-test gate. Author and
committer identities for the reviewed commits and merges are JohnJiang.

## Merge, deployment and release

Authorized targets remain the existing staging.unimailbox.tech and
mail.leanda.tech installations in account 6f215b03c5ff77ef28410254e9701d67.
Preserve resources, secret identities/values, catch-all/forwarding and current
AI/MCP settings. Require backups/recovery bookmarks, exact-source publication,
all 37 SQL companions, readiness/maintenance and actual scheduled D1 evidence.
No application mail API reads, sends, DNS or routing changes are required.

Fix commit `b054f69`, version/review commit `9ac32f1`; merged main `316428d`.
No external review comments were present. Gitleaks v8.30.1 scanned all 15 PR
commits and reviewed staged additions without findings.

Fresh private D1 exports for both installations restored into SQLite with
integrity/FK checks passing at schema 0037. Production/staging export sizes were
521,671 and 475,361 bytes. Refreshed final pre-publication exports were
522,640 bytes (production, SHA-256
`11d8e5851bc02b00ec05895d3023c47b63026b816e31e89b26484fd85af035fe`)
and 480,908 bytes (staging, SHA-256
`f5447788c9dcc05242cc1681d159c05663de9e53f1035557f3ce632a11397c55`),
again restored with integrity/FK checks passing at schema 0037. Raw exports,
private credentials and binding/config snapshots remain in ignored protected scratch. The normal publication flow
captures a fresh Time Travel bookmark for each target.

The initial staging candidate published Worker `fb7582f9-1e4e-4535-9d77-1ab2289d96fa`, source
`316428d`, schema 0037. All 37 remote SQL companions passed, no new migration
was applied and a recovery bookmark was captured. Exact-source release smoke,
readiness and repeated maintenance checks passed. At 18:29 Asia/Shanghai,
authenticated login/version/personal-page checks passed with product 1.0.1;
a temporary read-only credential initialized MCP as 1.0.1 and was revoked,
with subsequent MCP access rejected. Diagnostic login was logged out. No mail
message was read or sent. Resource bindings and AI/MCP settings matched the
pre-release snapshot; staging MCP remains enabled as before. This candidate also passed a real
18:30:21 D1 scheduled update. A later compatibility assertion exposed its legacy
response issue, so production publication of that prepared source was paused.
It was never tagged as 1.0.1. PR #49 subsequently fixed this compatibility
issue; the final source and runtime evidence below supersede that candidate.

### Final staging acceptance

Final source `b4b7ca3ae5ce80d1436997fd2ddc012ae7a16bfa` published as
Worker `f6f50606-9123-45e7-bfbd-d5f675e67116`. Application tree digest:
`199d0a148409c19a440e2a233328441e33a5344736ed5b5e33149531e7e204ba`.
The final preparation passed 2,415 tests. All 37 remote SQL companions passed,
no SQL migration was applied, and publication captured a recovery bookmark.
A transient Cloudflare identity-fetch network failure before remote writes was
resolved by resuming the exact prepared artifact.

At 10:55:16 UTC, authenticated login/administrator version, legacy response
without nextCursor, opted-in pagination response and owner token-page checks
passed. A temporary read-only MCP credential initialized with version 1.0.1,
was revoked and then rejected; diagnostic login was logged out. At 12:15:12 UTC,
repeated health/maintenance and preserved binding/configuration checks passed.
Actual frequent Cron advanced to 12:10:21 UTC and hourly Cron to 12:00:21 UTC,
with zero failed tasks. Daily state was retained from its previous successful
run; a new daily run was not awaited. MCP remains enabled as before.

### Final production acceptance

The exact prepared final source published as Worker
`e5ffa021-02a6-46a9-a9b9-2958e02d8f37`, with the same revision and application
tree as final staging. Preparation passed 2,415 tests; publication captured a
fresh D1 recovery bookmark, verified all 37 SQL companions and applied no
migration. Exact-source HTTP smoke and readiness passed.

An unrelated uncommitted MCP-page change appeared in the original checkout
after preparation. It was preserved. Publication used a separate clean checkout;
source/config/assets digests still matched the reviewed prepared manifest.
The first package-script invocation stopped locally at pnpm's dependency-layout
check before any remote operation; the same repository dispatcher was invoked
directly with the pinned Node/toolchain and completed its normal release checks.

At 12:19:57 UTC, repeated health/maintenance checks and resource/key-binding/
AI/MCP/prompt comparisons passed. MCP remains disabled in production. No DNS,
routing, forwarding, provider or secret-value change was made.

At 12:19:53 UTC, administrator login/current version, exact legacy response,
opted-in pagination and the bounded owner-token page passed; the diagnostic
session was logged out. MCP was not enabled and no credential was issued in
production. At 12:21:11 UTC, health/configuration checks passed again and the
real frequent Cron had advanced to 12:20:44 UTC, completing at 12:20:45 UTC
with zero failed tasks. Hourly/daily prior successful state was retained;
new production hourly/daily runs were not awaited.

These checks cover the release's operational/API scope. They do not retest
external mail delivery, attachment recovery, a full post-release quota day,
notification receipt, the full acceptance catalog or all dependency advisories.

### Public release

Annotated tag `v1.0.1` points at verified final main source
`b4b7ca3ae5ce80d1436997fd2ddc012ae7a16bfa`; product version is 1.0.1.
The [tag workflow](https://github.com/UniMailbox/Unimailbox/actions/runs/38733424533)
passed its complete canonical gate and version/main-history checks, then created
a draft. Its generated notes were replaced with the reviewed release notes,
including migration, recovery, scope and known dependency-advisory boundaries.
The stable [v1.0.1 Release](https://github.com/UniMailbox/Unimailbox/releases/tag/v1.0.1) was published at
2026-10-15T12:26:22Z and verified through GitHub's public latest-release
endpoint as tag v1.0.1, draft=false and prerelease=false. Notification receipt
and installations' six-hour update cache refresh were not asserted.

Subsequent evidence/ledger commits change documentation only. The release tag
and both published Workers retain the verified source above; no tag movement
or documentation-only redeployment is required.
