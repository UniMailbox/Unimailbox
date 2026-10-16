# Mail reliability, resource dashboard and AI governance — staging, 2026-10-16

Published [PR #51](https://github.com/UniMailbox/Unimailbox/pull/51) source
`ccbf09edf05e9ba58f23e4e36939b307302cf87f` to
<https://staging.unimailbox.tech>. Worker version
`aab643b4-cace-476e-9c20-33a150bc6721`; schema **0042**; product version
remains 1.0.1. The PR includes the separately committed inbound/outbound recovery,
resource dashboard, shared mail mutation, query/cache and AI governance slices.
The subsequent QA documentation commit does not change deployed application code.
Production and the stable v1.0.1 tag are unchanged.

## Release and recovery evidence

- Published through the standard prepared-release flow from a clean isolated
  checkout. Exact revision/tree, config/migration/assets digests and version
  matched deployment smoke. Prior Worker was
  `f6f50606-9123-45e7-bfbd-d5f675e67116`.
- Repeated complete `pnpm verify`: **2,565 tests** (1,431 non-Worker,
  1,104 Worker, 30 migration fixtures), doctor 14/14, generated bindings, lint,
  TypeScript and Web/Worker builds. Existing source-map/bundle warnings and four
  local connection-lost messages did not fail the gate. GitHub Verify, CodeQL
  and secret scans passed on the deployed source.
- Gitleaks 8.30.1 scanned 428 reachable commits with repository fixture rules:
  no leaks. The unrelated personal MCP edit was excluded from source publication
  and deployment; its original hash remains unchanged.
- Before migrations, exported D1 at schema 0037, restored into private SQLite,
  passed integrity/foreign-key checks, copied all 37 objects returned by the
  paginated R2 inventory (74,681,619 bytes), and verified saved object hashes.
  The retained recovery key decrypted both stored credential payloads.
  An AES-256-GCM backup archive was authenticated/decrypted and its tar index
  read successfully. Backup data, keys and release manifests remain private.
  This is a local recovery check; no remote restore, write-quiesced joint
  snapshot or measured RPO/RTO disaster-recovery exercise was performed.
- Publisher captured a fresh pre-migration D1 Time Travel bookmark, applied
  0038–0042 in order, and passed all **42 remote SQL companions**. The backup
  contained zero legacy jobs requiring migration-0039 quarantine; no ambiguous
  message was deliberately retried.
- Existing D1/R2/KV/Queue/Secrets Store bindings and application variables were
  preserved, apart from release identity/assets. AI configuration, MCP settings
  and prompt remained identical to their pre-release metadata snapshots.
  No credentials were rotated or resources recreated.

## Live acceptance

- Standard exact-version smoke passed health, schema, completed setup/login,
  CSP, hashed assets, missing paths and source-map protection. `ops:check`
  passed readiness and maintenance health checks.
- Anonymous governance, personal-usage and resource routes returned 401.
  Administrator sign-in and logout succeeded; governance/personal/installation
  usage responses passed strict shared schemas. Own usage matched the explicit
  same-user administration filter. No inference attempt was created.
- AI policy is **observe**, with no verified model profile. Byte/concurrency
  safety caps apply; token budgets are recorded but are not enforced in this
  mode. Enforcing the requested token ceilings still requires actual model-bound
  evidence pinned to the current configuration. No external model is certified
  by this deployment, and no paid inference was invoked.
- The resource endpoint returned five explicit `not_configured` platform
  services: the optional Cloudflare Analytics reader credential is absent.
  Existing credentials were not repurposed. All four application-metadata groups
  (mail, attachments, outbound, receipts) returned `ready`. API checks establish
  live data availability; visual browser acceptance was not repeated.
- Legacy personal MCP settings still omitted the opt-in pagination key.
- A real five-minute scheduled tick ran at 11:55:21–11:55:22 UTC (19:55 Asia/Shanghai), with a new request identity after the initial probe and zero failures. All three retained cadence heartbeats remained healthy.

## Remaining boundaries

No external email was sent/received for this release, no provider callback or
post-submit disconnect was exercised live, and no real-model token/cost/billing
bound, full quota period, historical-client compatibility catalog or full
D1/R2/key disaster-recovery exercise is claimed. Self-review only.

Migration 0039 protects legacy ambiguous submissions; do not blindly resend them.
Rollback must consider pending inbound receipts and AI reservations/unknown holds:
older schema-readable Workers do not implement these semantics. Keep the
pre-release backup/bookmark and matching keys; inspect current provider/data state
before any rollback or restore.

See [AI governance](../rebuild/24-ai-usage-governance.md),
[resource dashboard](../rebuild/22-resource-usage-dashboard.md),
[deployment recovery](../operations/deploy.md#rollback-and-data-recovery) and
[AI handoff](../../work/handoffs/ai-governance-2026-10-16.md).
