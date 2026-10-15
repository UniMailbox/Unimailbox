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

Local verification layers passed on the final source: 1,374 non-Worker,
1,012 Worker and 28 migration tests (2,414 total), doctor 14/14, generated
bindings, lint, TypeScript and builds. After removing the redundant component
guard/test, the final non-Worker suite, lint and TypeScript were rerun; Worker
source remained unchanged. Exact-head GitHub canonical gates and clean merged
release preparations remain pending before publication.

## Merge, deployment and release

Authorized targets remain the existing staging.unimailbox.tech and
mail.leanda.tech installations in account 6f215b03c5ff77ef28410254e9701d67.
Preserve resources, secret identities/values, catch-all/forwarding and current
AI/MCP settings. Require backups/recovery bookmarks, exact-source publication,
all 37 SQL companions, readiness/maintenance and actual scheduled D1 evidence.
No application mail API reads, sends, DNS or routing changes are required.

MERGE_DEPLOY_RELEASE_PENDING
