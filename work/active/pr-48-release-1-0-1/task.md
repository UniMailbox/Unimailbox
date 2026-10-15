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
public metadata. No new mail sends, credentials, DNS or service enabling.
