# Resource dashboard: platform and mail processing

The user's late clarification requested both kinds of resource data in separate
sections. Continued locally on `codex/resource-dashboard-20261016`, base
`0d61ab9`. Prior reliability and platform-dashboard changes remain uncommitted;
the unrelated personal MCP edit is unchanged. No commit, push, deployment,
Cloudflare account query, credential operation or real private-mail access.

## Delivered

Admin Overview now has **Cloudflare platform usage** and **Mail processing**
sections. Both have independent 7/30-day UTC controls, manual refresh, metric
selection, keyboard values, daily tables, English/Chinese and mobile layout.
The platform section retains its optional dedicated read-only credential.
The mail section reads local metadata and works without it.

The new `analytics.read`-protected mail endpoint aggregates inbound message
counts; decoded/legacy attachment and hosted-asset counts/bytes; current outbox
states, retry reservations and created-to-sent latency; and retained receipt raw
sizes, incomplete work, extra claims and completion latency. It never returns
private bodies, subjects, addresses, IDs, keys or provider credentials. Averages
are weighted by valid sample count. Temporary errors preserve data, but revoked
authorization hides it. No polling or per-message telemetry writes.

Migration 0040 adds outbox/receipt creation-time and hosted-relation lookup
indexes. Each cohort is limited to 5,000 records; affected metrics are withheld
at overflow. Query plans use indexes and independent aggregates prevent relation
multiplication. [Canonical design](../../docs/rebuild/22-resource-usage-dashboard.md)
owns the definitions, retention coverage and release requirements.

## Validation

Final isolated `pnpm verify` passed doctor 14/14, generated binding drift, lint,
TypeScript, builds and 2,511 tests: 1,422 non-Worker, 1,061 Worker and 28 migration
fixtures. All 72 changed app/contracts/test-kit/migration paths match the shared
checkout byte-for-byte. The isolated gate uses committed personal MCP UI; its
unrelated user edit and prior three failures remain outside this acceptance.

Focused component tests passed 13 cases across the two panels; six new local-D1
tests prove authorization, input boundaries, metadata privacy, UTC mixed-format
timestamps, attachment/job count independence, weighted sample inputs, negative
duration exclusion, receipt cleanup, record caps and 0040 verification/query plan.
The final full gate covers extraction of the shared chart and query hook.

Actual local browser rendering with synthetic APIs passed desktop 1440px/mobile
390px layouts, independent ranges, platform failures alongside local mail data,
outbound latency/receipt/attachment views and 30 daily rows. Zero page errors or
document overflow. Component screenshots omit the overlapping sticky app header
only during capture. Raw logs/screenshots stay ignored under
`.tmp/mail-processing-dashboard/`; they are not live platform/mail evidence.
Main-agent self-review only.

## Remaining acceptance

Mail charts describe **current retained metadata**, grouped by creation date,
rather than immutable historical delivery events. Receipt raw sizes and inbound
latency lose completed samples after about 24 hours. Missing receipt data remains
null; message/task counts can change after deletion or cleanup. Latency includes
queueing, scheduled waiting and recovery and does not measure CPU or memory.
Retry reservations/extra claims are not proof of another upstream submission.

Before publication on an explicitly selected installation, apply the normal
backed-up schema 0040 upgrade, retaining earlier 0038–0039 restrictions. Verify
actual mail metadata and live Cloudflare dataset entitlement/resource scoping
separately. No live installation was modified in this task.
