# Administrator resource usage dashboard

Implemented locally from main `0d61ab9` on
`codex/resource-dashboard-20261016`. The user requested resource consumption
charts in Admin Dashboard. The existing inbound/outbound reliability work and
unrelated personal MCP UI edit remain intact. No commit, push, deployment,
Cloudflare account access, token creation or real provider operation occurred.

## Delivered

- `/admin` contains installation-wide Cloudflare resource charts for Workers,
  D1, KV, R2 and Queue. The mailbox domain filter does not scope platform usage.
- 7/30-day UTC windows, manual refresh, metric selection, keyboard/focus values,
  accessible daily tables, mobile layout and English/Simplified Chinese.
- Permission-gated endpoint, explicit resource filters, dedicated optional server
  analytics token, bounded requests/JSON and regional five-minute Cache API
  snapshots. No telemetry writes, schema change or polling.
- Missing samples remain null, counter summaries use recorded totals and storage
  uses maxima. Provider failures are isolated. Temporary refresh failures retain
  previous data; authorization failures hide previously cached data.

[Canonical design/configuration](../../docs/rebuild/22-resource-usage-dashboard.md)
owns metrics, source provenance, resource limits and optional installation inputs.
The public Cloudflare protocol docs are pinned there; no external implementation
code is copied. Existing shadcn-admin design authority is preserved. This is a
source self-review, not independent review.

## Evidence

Final isolated `pnpm verify` passed doctor 14/14, generated bindings, lint,
TypeScript, Web/Worker builds and 2,500 tests: 1,417 non-Worker, 1,055 Worker and
28 migration fixtures. All 63 changed application/contracts/test-kit/migration
paths match the shared checkout byte-for-byte. The validation checkout retains
committed personal MCP UI; the unrelated user edit is unchanged and excluded,
with its three prior failures recorded in the earlier inbound handoff.

An initial gate passed application checks but hit two local runtime reset-hook
timeouts in unchanged 0037 migration fixtures. The standalone 28-fixture retry
and final complete gate passed without changing migrations or timeout settings.

Focused new tests cover all five scoped queries, counter/storage semantics,
missing samples, forbidden/failed/malformed/oversized/truncated provider data,
credential/resource/window cache separation, duplicate namespace rejection,
authentication/permission/query-input checks, range/resource/metric controls,
refresh recovery, authorization revocation and absence of focus/reconnect reads.

Actual local browser rendering with synthetic APIs passed desktop 1440px and
mobile 390px layouts, range/resource changes, all 30 daily values, provider
permission failure and zero page errors/document overflow. Screenshots/raw logs
are ignored private scratch under `.tmp/resource-dashboard/`; they are fixture
evidence, not real Cloudflare resource usage.

## Remaining acceptance

The panel shows setup guidance until a selected installation has a dedicated
read-only analytics token and explicit account/resource map. No credential value
is placed in the browser or documentation. Follow the canonical configuration
guide and normal protected release workflow when authorized. Verify actual
GraphQL schema/dataset entitlements, resource scoping, cache/freshness and values
against that installation's Cloudflare dashboard after publication.

CPU time, memory peaks, billing/free-plan quotas and maximum-mail load/budget
acceptance are not represented by these counters or storage measurements.
Earlier schemas 0038–0039 and their upgrade restrictions still apply to the
uncommitted reliability work; this dashboard introduces no additional migration.
