# Staging KV request reduction — 2026-10-14

## Live baseline before this change

Read-only Cloudflare GraphQL snapshots were collected at 01:51–01:52 UTC
(09:51–09:52 Asia/Shanghai). The selected installation is
`https://staging.unimailbox.tech`, account `6f215b03c5ff77ef28410254e9701d67`,
CACHE namespace `058a382c046940aa8c24f37a066db803` (`unimailbox-staging`).
The preceding release `fd7fa1b2-5d45-49ea-9e70-9b90753edf72`, source `e24bf27`,
still served 100% of traffic; exactly one five-minute Cron remained configured.

| UTC day | Read | Delete | Write |
| --- | ---: | ---: | ---: |
| October 10 | 5 | 0 | 314 |
| October 11 | 5 | 0 | 313 |
| October 12 | 337 | 2 | 331 |
| October 13 | 135 | 1 | 331 |
| October 14, partial through 01:51 UTC | 0 | 0 | 25 |

The exact preceding 24-hour window ending at 01:52:41 UTC had **67 reads,
zero deletes and 324 writes**. Account-wide namespace aggregates likewise
showed no high delete count during October 12–14. October 13 production CACHE
had five reads, zero deletes and 314 writes; no production operation was changed.

Hourly staging data has long stretches without reads/deletes and five daily
scan reads at 19:00 UTC (03:00 the next day in Asia/Shanghai). This evidence
does not show the old continuous empty-delete maintenance recurrence. Most
other reads occur in discrete activity periods, consistent with authenticated
browser/API use; aggregate analytics do not prove individual keys or clients.
The operator's separately observed alert threshold/window remains unspecified.

Cloudflare's dashboard and these queries use the same
[`kvOperationsAdaptiveGroups` dataset](https://developers.cloudflare.com/kv/observability/metrics-analytics/).
UTC daily buckets are not Asia/Shanghai calendar days. Raw aggregate JSON and
credential-reading helper code remain private ignored scratch, not attachments.

## Changes and local evidence

Browser identity descriptors now remain fresh for 60 seconds instead of becoming
stale immediately. Existing page, data-query and navigation consumers share
the same result; an inbox with a fresh guarded identity uses **zero additional
`/auth/me` calls**, where the previous footprint test required two. Stale mounts
and explicit invalidation still recheck identity. Login/password change/logout
cache updates and the explicit fresh admin-entry check remain intact.

Unauthenticated logout clears the refresh cookie without deleting a missing,
expired or revoked token key. Actual binding spies prove zero KV deletes for
these cases; valid logout still deletes exactly once, revokes its D1 session,
and prevents both access-token and refresh-token reuse. Repeated logout adds
no further delete. Existing KV TTLs, fresh D1 checks and permissions remain.

Focused tests passed: Web identity/logout/router 76; expanded identity/inbox/
detail/router 111; Worker auth/MCP/account lifecycle 57. The initial full gate
stopped before publication on an obsolete two-read footprint assertion and a
detail fixture that replaced explicit null identity with a logged-in value.
Both fixtures were corrected without relaxing product security; focused rerun
passed. Main-agent self-review only; no independent reviewer is claimed.

MCP's existing no-polling and zero browser-KV authentication changes remain.
No schema, resource, secret, provider, mail or production change is introduced.
The frequent recovery and hourly/daily maintenance cadences are unchanged.

## Publication and acceptance

Application changes: `72d86f6`; fixture correction/release source: `79ceaf2`.
The canonical gate passed **2,397 tests**: 1,372 non-Worker, 999 Worker and 26
migration fixtures. Doctor 14/14, generated bindings, lint, TypeScript and
fresh builds passed. All 36 remote read-only SQL companions passed; schema
remains 0036 with no migration applied.

- Published Worker: `1e0bdd33-1a59-4698-834b-10946a7bc7eb`.
- Previous Worker: `fd7fa1b2-5d45-49ea-9e70-9b90753edf72`.
- Release source: `79ceaf2e99781becddc61ed6578e454c615e2895`.
- Source digest: `9b468e7aa508294ede2f952fe08f595a46e83909ecb6a36066af95bb5596fcd5`.
- Frontend digest: `cb2f41121c7076d10f6b57ef6c426b9d4003d7e7e64aca6312f5c573735467d1`.
- Standard `pnpm deploy:staging` completed from clean committed application
  inputs. The manifest is verified; account/resources/secrets, a D1 recovery
  bookmark, exact release identity, readiness, completed setup, current assets,
  security headers and protected/missing-path smoke checks passed.
- `pnpm ops:check --environment staging` passed readiness and maintenance health.
- Live acceptance started at 02:07 UTC (10:07 Asia/Shanghai). Login, identity,
  valid logout, repeated logout, invalid-token cookie clearing, and denial of
  both old access and refresh credentials passed. The diagnostic session was
  logged out. No configuration was changed, private mail read or mail sent.

New source must be loaded by refreshing already-open staging tabs. The request
count reduction is covered by frontend component/router tests; a native browser
network capture and a full post-release usage day have not been demonstrated.
The live authentication checks establish server behavior, not per-call remote
KV counts. Those operation counts come from the local real-binding tests.

The pre-change low counters are evidence of the previous release, not a measured
post-change saving. The exact ongoing reduction depends on browser/API activity;
neither application tests nor one aggregate snapshot guarantees zero total KV
use or a particular future account quota threshold.
