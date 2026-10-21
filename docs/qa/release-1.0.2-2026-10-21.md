# PR #51 and version 1.0.2 — 2026-10-21

## Reviewed source and local gates

[PR #51](https://github.com/UniMailbox/Unimailbox/pull/51) merged as
`c97bea825bd46e4047a8dc4b756d66464040c805`. Its tree matches reviewed head
`992cb54fdc40c7eeaff16b98f02f514606eb8ba2`. The annotated `v1.0.2` tag points
at that merge; `APPLICATION_VERSION` is 1.0.2. Author and committer identities
were retained. No independent review is claimed.

The release includes durable inbound receipts, outbound uncertain-submission
recovery, separate platform/application resource charts, shared mail mutation
use cases, query/cache improvements and AI governance. The
[review record](../../work/reviews/PR-051-resource-ai-review-2026-10-16.md)
owns the terminal AI rejection, missing-binding and delayed mailbox-read fixes.

Release CI exposed a further clock mismatch: governance replay writes used the
injected clock while replay reads used SQLite's actual time. Fix `992cb54`
uses the same clock on both paths and verifies exact 24-hour expiry and
request-body conflicts. Both original failing CI runs are retained; the code
was corrected before the successful runs.

Final staging and production preparations each passed complete `pnpm verify`:
**2,582 tests** (1,436 non-Worker, 1,116 Worker, 30 migration fixtures),
doctor 14/14, generated bindings, lint, TypeScript and builds. Exact-head PR
checks passed; merged-main Verify, CodeQL, Secret scan and the tag's full
verification/version/ancestry gate passed. Existing dependency advisories are
not resolved by this release.

The shared checkout's personal MCP setting edit and untracked `docs/product/`
were preserved and excluded. Deployment used clean, isolated release checkouts.

## Recovery protection and migration

Authorized existing targets remain `staging.unimailbox.tech` and
`mail.leanda.tech` in account `6f215b03c5ff77ef28410254e9701d67`.
No resource replacement, key rotation, DNS/routing/forwarding change, provider
configuration change or initial setup was performed.

Before production migration on October 21, a fresh D1 export at schema 0037
restored into private SQLite with integrity and foreign-key checks passing.
All 13 R2 inventory objects (653,093 bytes) were saved and their stored hashes
verified. The retained credential key decrypted the stored credential payload.
The encrypted recovery archive authenticated, decrypted and exposed a readable
tar index. Data, keys, configuration snapshots and manifests remain in protected,
ignored storage. This is local recovery validation, not a coordinated
write-quiesced snapshot or a measured Cloudflare disaster-recovery drill.

Staging's October 20 refresh similarly verified schema 0042, 37 R2 objects
(74,681,619 bytes), matching keys and two encrypted credentials. Previously
saved object bytes were reused only after matching the current inventory
identity/ETag/time/size and checking their saved hashes.

Production Queue delivery was confirmed paused at `2026-10-21T01:10:18.867Z`.
All three existing outbound jobs were already sent; no sending or due queued
work existed. The publisher captured a fresh pre-migration Time Travel bookmark,
applied **0038–0042** in order and passed all **42 remote SQL companions**.
No legacy ambiguous job required quarantine.

After the verified new Worker became ready, delivery was confirmed active at
`2026-10-21T01:13:33.259Z`. Queue delay, retention and producer/consumer topology
were preserved. Existing jobs remained sent; no submission, inference attempt
or inbound receipt was created by the release checks.

## Published installations

Both candidates have application tree digest
`f291c6812843e32d363824a4820bff821cdedf93ccbc3911d7f24f71527e30b8`.
Staging uses the reviewed head; production uses its tree-identical main merge.

| Installation | Source | Worker version | Schema |
| --- | --- | --- | --- |
| Staging | `992cb54fdc40c7eeaff16b98f02f514606eb8ba2` | `ef107a5b-a26e-4203-8573-969a779d2b1b` | 0042 |
| Production | `c97bea825bd46e4047a8dc4b756d66464040c805` | `9df477ac-eaa9-45ed-8ba6-6468ff04e46a` | 0042 |

Normal prepared-release smoke passed exact Worker/revision/tree identity,
readiness/schema, completed setup/login, security headers, hashed assets and
missing-path/source-map protection. Production's prior Worker was
`e5ffa021-02a6-46a9-a9b9-2958e02d8f37`, source `b4b7ca3`, schema 0037.

At `2026-10-21T01:13:33.347Z`, production's authenticated metadata checks passed:
current product version 1.0.2 and exact revision, governance/usage/resource
contract parsing, own-user scope and legacy/opted-in MCP projections.
Anonymous protected routes returned 401. The diagnostic session logged out.
Existing bindings, AI configuration, MCP settings and prompt matched the
pre-release snapshot; production MCP remains disabled.

AI governance remains **observe**, with no verified model profile. Byte and
concurrency caps apply; token ceilings require model-bound evidence at the exact
AI configuration revision before enforcement. No paid inference was invoked.
All four application mail-metadata groups returned `ready`. Five optional
platform services returned `not_configured`: no Analytics reader credential
was configured or repurposed.

Staging's real frequent scheduled tick advanced to
`2026-10-21T01:05:20.715Z`–`01:05:21.803Z`, after its initial acceptance probe.
All retained daily/hourly/frequent snapshots had zero failures.

Production's operations check passed. A new frequent tick ran at
`2026-10-21T01:15:44.234Z`–`01:15:45.301Z`, after the initial production probe,
with a changed request identity and zero failures. Repeated exact-source health,
bindings and configuration checks passed at `01:15:58.592Z`. The prior successful
hourly/daily snapshots were retained; new hourly/daily runs were not awaited.

## Stable release

The [tag workflow](https://github.com/UniMailbox/Unimailbox/actions/runs/39442910343)
passed and created a draft. Its notes were replaced with reviewed changes,
migration/recovery requirements, compatibility/AI constraints, deployment
evidence and known limits. The stable
[v1.0.2 Release](https://github.com/UniMailbox/Unimailbox/releases/tag/v1.0.2)
was published at `2026-10-21T01:16:46Z`. GitHub's public latest-release endpoint
returned `v1.0.2`, `draft=false`, `prerelease=false`.

Notification receipt and installations' six-hour update-cache refresh are not
asserted. Later evidence/ledger commits change documentation only; the tag and
published Workers retain their verified source. No retag or redeployment follows
from this documentation update.

## Monitoring and acceptance limits

The latest observed GitHub Operations run
[#39524966720](https://github.com/UniMailbox/Unimailbox/actions/runs/39524966720)
failed because Cloudflare returned a managed challenge HTML page to the
staging `/readyz` probe. Direct local health/API checks and the actual scheduled
heartbeat passed. The remote monitoring path remains an explicit operational
gap; this release did not alter Cloudflare challenge or security rules.

No external mail delivery, live provider post-submit disconnect/callback,
provider duplicate suppression, real-model token/billing bound, full quota
period, full historical-client compatibility catalog, browser UI rerun or
coordinated D1/R2/key restore is claimed. Refer to the
[upgrade guide](../operations/updates.md) and
[recovery runbook](../operations/deploy.md#rollback-and-data-recovery).
Do not blindly resend uncertain submissions or roll back to pre-0038/0039
processing code while new receipts/attempts exist. Additive schema alone does
not make the older processing behavior safe.
