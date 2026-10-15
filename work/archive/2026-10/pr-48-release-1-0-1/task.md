# Review PR 48, fix findings and release 1.0.1

Started 2026-10-15. User explicitly authorized review, fixes, merge, staging and
production publication and stable 1.0.1 release. Main-agent review only; no
independent reviewer/delegation is claimed. Preserve existing installation
resources, key values, mail routing/forwarding and feature settings.

Review scope: complete diff against actual origin/main, MCP transport/auth/
scope/idempotency, personal/admin UI, identity cache/logout, D1 heartbeat
concurrency/freshness/handover, migrations and release/deployment procedures.
Confirmed findings: disabled-service UI prevents credential revocation despite
backend support; LIMIT 100 credential listing hides older credentials without
pagination. MCP handshake also needs product version instead of a literal.

Fix with regression tests, on-demand bounded pagination and disabled-service
revocation while keeping new issuance/prompt copy gated. Bump APPLICATION_VERSION
to 1.0.1 and prepare reviewed release notes. Full canonical gate, secret scan,
GitHub checks before merge. Deploy exact merged source to staging then production
with backups/recovery bookmarks and all schema assertions, compare preserved
bindings/configuration and real D1 Cron/health. Tag the verified main source,
wait for release workflow gate, publish stable/latest GitHub Release and verify
public metadata. No mail sends, DNS or service enabling. Any temporary read-only staging
diagnostic credential must be revoked and diagnostic sessions logged out.

PR #48 merged as 316428d after exact-head CI passed. Initial staging publication
passed tests/health/login/new API/MCP version and real D1 Cron, but a cached-client
response compatibility regression was reproduced before production publication.
Fix it in a follow-up branch/PR via explicit pagination opt-in, preserving the
old strict response. The old prepared production artifact is superseded and must
not be published. Final deploy/tag source must include the compatibility fix.

PR #49 merged as b4b7ca3 after its exact-head checks passed. Final staging
publication and authenticated legacy/new-client/MCP-version/revocation checks
passed. Real five-minute and hourly D1 runs were observed with zero failures.
Both final preparation gates passed 2,415 tests. The v1.0.1 tag points at this
final source; production publication and the release workflow remain in flight.
An unrelated uncommitted personal-settings change in the original checkout was
preserved; publication uses a clean checkout with matching prepared identities.

Completed: production authenticated/API and actual scheduled D1 acceptance
passed, matching tag workflow passed, and stable/latest 1.0.1 was published.
See docs/qa/release-1.0.1-2026-10-15.md for final evidence and limitations.
The notes above retain the intermediate execution history.
