# Administrator resource usage

The existing `/admin` overview contains separate **Cloudflare platform usage**
and **Mail processing** sections. Platform usage is backed by
`GET /api/v1/admin/resource-usage?days=7|30`; local mail statistics use
`GET /api/v1/admin/mail-processing?days=7|30`. Authentication and `analytics.read`
are required before reading credentials, caches or provider data. Browser input
cannot select an account or resource. The panel is installation-wide, independent
of the mailbox overview's domain filter. Neither endpoint returns private mail,
mailbox identities, object keys or credentials.

## Mail processing metrics

The mail section reads only retained relational metadata. It works without a
Cloudflare analytics credential and has independent UTC 7/30-day controls,
manual refresh and per-day tables. The sections share graph/formatting primitives
but have separate query keys and failure states.

| Category | Meaning |
| --- | --- |
| Mail volume | Canonical retained inbound messages, identified by an existing raw MIME reference; shared mailbox relations cannot multiply the count. |
| Attachments | Decoded inbound and legacy outgoing attachment metadata count/bytes, plus editor-hosted file/image usage per message. Draft relations count; unreferenced uploads and signature-only usages do not. These describe retained relations, not unique R2 storage or provider-encoded wire bytes. |
| Outbound processing | Tasks created in the selected window, current queued/failed states and recorded unknown-outcome flags, retry reservations from `outbound_jobs.attempts`, and average created-to-local-sent latency for valid completed samples. Retry reservations include recovery/preparation failures and do not prove another provider submission. |
| Retained receipts | Current receipt sample count/raw byte sum/raw maximum, incomplete samples, additional processing claims and average receipt-to-completion latency. |

All cohorts group by creation date and reflect **current retained state**, not
immutable historical events. Cleanup/deletion changes historical results. Jobs
created before the selected range are excluded even if still outstanding. Completed
inbound receipts expire after approximately 24 hours: older raw sizes and inbound
latencies cannot be reconstructed from the remaining metadata. Missing receipt
samples/latencies remain null; an empty retained-message/task count is zero.

Latency includes queueing, scheduled waiting and recovery, rather than measuring
CPU execution. Invalid/negative durations are excluded. Daily means carry valid
sample counts; the period average weights each day by its count rather than
averaging the daily means. No sample gives a null average.

Each message/outbox/receipt cohort is capped at 5,000 rows. A cap breach omits the
affected category's metrics rather than exposing partial totals. SQL aggregates
return at most 30 daily rows and never load message bodies or attachment bytes.
Attachment subqueries avoid Cartesian multiplication across relations/jobs.
Migration `0040_mail_analytics_indexes.sql` adds outbox/receipt creation-time and
hosted-usage lookup indexes. It changes no mail state and adds no telemetry table,
per-message write or Cron. Publish matching source only after applying the
normal backed-up schema 0040 upgrade, retaining earlier 0038–0039 restrictions.

## Platform metrics and interpretation

| Resource | Daily metrics | Period summary |
| --- | --- | --- |
| Worker | Requests, errors, subrequests for the configured script | Sum of recorded counters |
| D1 | Rows read/written and read/write query counts for the configured database | Sum of recorded counters |
| KV | Read/write/delete/list requests across the explicitly configured namespaces | Sum per action across those namespaces |
| R2 | Operation requests, stored object payload bytes and object count for the configured bucket | Operations summed; storage/object counts use the maximum reported value |
| Queue | Message-operation count and bytes across read/write/delete operations for the configured queue | Sum of recorded counters |

These are Cloudflare Analytics aggregates. They may be sampled/delayed and the
current UTC day is incomplete. Missing samples remain null, displayed as a dash
and explicitly different from zero. Partial-range summaries say "recorded period
total"; storage says "period maximum". Graphs have keyboard-readable values and
an expandable daily table. There are no inferred bills, free-plan quotas, CPU
time or memory peaks. Message sizes are not substituted for runtime memory.
Mail-specific budget enforcement and maximum-mail load measurements remain a
separate engineering task.

## Optional installation configuration

No analytics credential is required for mail service. An unconfigured installation
shows setup guidance; one unconfigured resource does not block other resources.
Invalid overall configuration is rejected without falling back to account-wide
queries. Select the intended installation/account before configuring anything;
repository maintainer IDs do not authorize an account operation.

Set `CLOUDFLARE_ANALYTICS_CONFIG` as a JSON string in the chosen Worker's `vars`.
The following identifiers are synthetic format examples and must be replaced:

```json
{
  "accountId": "00000000000000000000000000000000",
  "workerName": "your-mail-worker",
  "d1DatabaseId": "11111111-1111-4111-8111-111111111111",
  "kvNamespaceIds": ["22222222222222222222222222222222"],
  "r2BucketName": "your-mail-attachments",
  "queueId": "33333333333333333333333333333333"
}
```

Only `accountId` is required in the map; omit resources that are not to be
monitored. KV accepts one to four distinct namespace IDs. Use the Queue **ID**,
not its name. R2 buckets with a jurisdiction require the documented prefix
(for example `eu_bucket-name`). Include both CACHE and SETUP_SESSION if both
namespaces should contribute; include only this installation's resources.

Create a dedicated account-scoped **Account Analytics: Read** token following the
[Cloudflare guide](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/).
Store it as the private Worker secret `CLOUDFLARE_ANALYTICS_TOKEN` using the normal
protected secret-input workflow, or bind that name to Secrets Store. Do not put
it in `vars`, a browser build, a settings response or a committed file. Do not
reuse the deployment API token. Dataset entitlement or permission failures remain
explicitly unavailable; do not solve them by automatically expanding token scope.
The UI neither provisions Cloudflare resources nor changes token permissions.

## Resource and security boundaries

- At most five independent provider requests per read, each with an eight-second
  HTTP/body deadline, 512 KiB response limit and 1,000-row query cap. Responses at
  the cap are rejected as possibly truncated. Queries group by UTC day, keeping
  normal result sizes well below that cap.
- Successful per-service snapshots use the local Cloudflare Cache API for up to
  five minutes. Cache keys include a hash of resources and credential plus the
  date window; rotation and scope changes cannot reuse another snapshot. Raw
  credentials are never cached. This cache is regional, not a global rate limiter.
- There are no interval/focus/reconnect fetches or layered client retries. Users
  refresh explicitly; a refresh may return a still-valid five-minute snapshot.
  No telemetry writes, new KV counters, database tables or Cron are introduced.
- Provider failures are isolated per resource and omit provider diagnostics and
  identifiers. Successful empty queries show no samples. A temporary browser
  refresh failure preserves previous data; HTTP 401/403 hides it immediately.
  The protected endpoint returns `Cache-Control: no-store` to the browser.

## Protocol provenance and remaining acceptance

Protocol documentation was retrieved on 2026-10-16 from the public
`cloudflare/cloudflare-docs` revision
`60d6f9d7a8f16042275cf5e1d481d37c5efbdfbd`, including:

- `src/content/docs/analytics/graphql-api/tutorials/querying-workers-metrics.mdx`
- `src/content/docs/analytics/graphql-api/getting-started/authentication/api-token-auth.mdx`
- `src/content/docs/d1/observability/metrics-analytics.mdx`
- `src/content/docs/kv/observability/metrics-analytics.mdx`
- `src/content/docs/r2/platform/metrics-analytics.mdx`
- `src/content/docs/queues/observability/metrics.mdx`

This implementation uses documented GraphQL fields; no external implementation
code was copied. The local gate uses synthetic HTTP and local bindings. Browser
screenshots use synthetic aggregates. Actual dataset/schema entitlement,
authorization, freshness and results for a selected Cloudflare installation
require separate acceptance after protected configuration and publication.
