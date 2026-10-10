# Deployment hardening — 2026-10-08

Follow-up to [the deployment review](../operations/deployment-review-2026-10-07.md), covering D-01 through D-11. The existing dirty checkout on `cap/CAP-065-mailbox-sharing-ui` was preserved. Delivery targets staging; production resources, real mail acceptance and external CI activation are separate boundaries.

## Changes

| Finding | Repair | Evidence / boundary |
| --- | --- | --- |
| D-01 | Explicit canonical environment config; account, origin, resource prefix and cross-environment identity checks; account/environment locks. Bootstrap is separate from publication. | `scripts/deployment-config.ts`, `deployment-runtime.ts`, failure-path tests. Production and preview templates fail until populated. |
| D-02 | Re-list D1/KV after creation; explicit remote Secrets Store commands; use queried secret ID for named rotation; reuse an unambiguous existing store; fail nonzero. | Pinned CLI help, contract tests and staging bootstrap. Full first-account provisioning was not performed. |
| D-03 | Migration reads fail closed on network, authentication, malformed JSON and failed result batches. Only a missing tracking table means a fresh database. | Remote orchestration and actual child-process local migration runner regression tests. |
| D-04 | Every publication attempt runs all read-only schema companions, including when SQL is already recorded. Local behavior fixtures are explicitly delimited. | Retry-after-failure regression; staging assertion results recorded below. |
| D-05 | Existing secrets are preserved. Bulk rotation is rejected; only installation and cursor keys can be selected independently. Direct encryption-key replacement is disabled. | Contract tests and staging bootstrap preservation checks. No existing secret was rotated. |
| D-06 | One verify/build/prepare/publish/smoke path; immutable source/config/assets digests; tool versions, prior Worker and recovery bookmark in a release manifest; local and CI serialization. | Full gate and release identity below. CI definitions are present, but no Git remote is configured. |
| D-07 | Custom-domain smoke is mandatory. Liveness reports release identity; readiness checks D1/schema and secret readability. | Actual staging HTTP checks below. |
| D-08 | Separate Worker rollback and data recovery procedures; retain release recovery metadata; document R2/key backup custody. | A separate temporary D1 database recovered a deleted synthetic row and was deleted afterward. Application D1 was not restored. External R2/key backup remains an operator setup item. |
| D-09 | Public sourcemaps disabled and excluded; static/API security headers; immutable hashed assets; explicit SPA fallback and real missing-file/API 404; failed lazy routes offer full reload. | Binding tests, actual HTTP and authenticated browser observations below. |
| D-10 | Independent outbound DLQ binding/consumer configuration; maintenance tasks isolate failures, record durations and persist an aggregate heartbeat; monitor heartbeat, DLQ depth and stale D1 outbox rows. | Real-binding failure injection and actual Cron/operations observations below. Poison-message exhaustion and redrive were not performed. |
| D-11 | Pin Node 22.23.2, pnpm 11.20.0, Wrangler 4.148.0, maintained Cloudflare Vitest plugin and Workers types; compatibility date 2026-10-06; generated binding type drift check. | Full regression gate. Root Wrangler resolves through the Worker workspace. |

## Gate reliability

The first full attempt exposed historical Brevo route tests that called the real provider and depended on private `.dev.vars` credentials. That attempt was interrupted after provider/network failures. These two suites now use shared MSW HTTP fixtures while retaining real D1/KV and complete route handling. They validate encrypted credential storage, payload recipient and idempotent sends, and reject unexpected external HTTP. Their final focused run passed 32 tests. This is simulated provider evidence, not real delivery acceptance.

The installed native runtime archive was checked against the official npm SHA-512 integrity before populating the local package cache. The committed lockfile retains registry integrity references; it contains no local archive, temporary registry or localhost dependency URLs. Frozen offline installation and peer dependency checks passed.

The first publication attempt stopped during read-only schema verification: remote D1 `--file` uses the bulk import endpoint and prints progress plus an import summary, rather than SELECT results. Verification now uses `--command=SQL` and still rejects non-JSON output and import summaries. A real remote query returned 53 passing assertions before the final release. The CLI runner also checks the installed workspace version and invokes the pinned bundle directly, avoiding package-manager output and the upstream bin wrapper's signal-to-zero behavior. Optional telemetry/version-banner network checks are disabled. Child-process tests prove signal failures remain failures. Read-only metadata/schema requests retry known transport failures at most twice; writes are never automatically replayed, and exhausted reads still stop publication.

The all-history verification also caught an initial-state assumption in migration 0025: its companion required the settings revision timestamp to remain at the seed epoch. Staging had a valid timestamp from a prior administrator settings update. The companion now checks the stable row value and a valid post-epoch timestamp; a real D1 regression accepts an ordinary update and rejects malformed timestamp data. No staging settings were reset or migration SQL replayed.

## Isolated D1 recovery drill

- Temporary database: `unimailbox-staging-recovery-drill-20261008053100`, ID `5c1740e7-5c71-4b95-a5bf-f253318577f3`.
- Created one synthetic fixture row, captured a Time Travel bookmark, deleted the row, confirmed count zero, restored the bookmark and confirmed the original row returned.
- Temporary database deletion was confirmed by a subsequent account list. Application database `e33add2e-154b-4e16-9c03-058bbc52a077` was not restored or used for the fixture.
- This proves the account's independent D1 restore path; it does not prove a coordinated D1/R2/key disaster recovery or production recovery time.

## Final release acceptance

The final `pnpm deploy:staging --dry-run` gate passed doctor 14/14, generated binding drift detection, lint, TypeScript, all builds and the staging-specific Wrangler bundle check. Tests: 1,250 unit/web/contract/script tests, 899 Worker route/binding tests and 20 migration binding tests; **2,169 total passed**. Frozen offline dependency installation and peer checks passed earlier with this lockfile.

Publication passed all 31 historical migration companions, with no pending SQL applied. Published staging version **`c10f5148-8735-47e5-a6ec-5fa324779044`**, with 100% traffic. Prior version: `8255eaef-5ce3-4392-aacc-0244df482f8f`. Release revision: `b1817e7edbbc5f223b9c02cd840edf9e25e561cd`; content tree: `0ae602e7f7057bc4d1d573f9d2e448196e42a5e55f94e76b75b983105d021e96` (dirty staging source is represented explicitly). Frontend entry: `/assets/index-CXoBUipr.js`. The release manifest ended in `verified` and retains the pre-migration D1 bookmark.

- Mandatory custom-domain smoke passed after bounded edge propagation: exact Worker version/tree, D1 schema `0031`, readable required secrets, login page/current JS, immutable hashed JS, missing JS/map and bare API 404, protected admin 401 with `AUTHENTICATION_REQUIRED`.
- Additional HTTP checks confirmed CSP, HSTS, frame denial, nosniff, referrer and permission policies, HTML revalidation and staging noindex. The previously exposed `/assets/index-B8USO41v.js.map` now returns JSON 404.
- Real remote consumer metadata confirms outbound retry exhaustion targets `unimailbox-staging-outbound-dlq` (batch 10, retries 5, wait 5000 ms). No poison messages were injected or redriven.
- New-version Cron ran at **2026-10-08 06:12:41 UTC**, `outcome: ok`. All five tasks succeeded: outbound reclaim, attachment expiry, editor asset expiry, avatar sweep and inbound orphan-object sweep; `cron.complete` recorded no failed tasks. The first operations check correctly failed before a heartbeat existed; after that Cron, readiness and maintenance checks both passed. This proves one observed maintenance run, not loaded cleanup/failure recovery.
- Authenticated browser reloaded the current hashed entry and rendered the inbox, existing QA message HTML/attachment list, compose toolbar and account settings. Existing avatar blob images loaded; the selected historical message contained a source-less image placeholder, so loading mail inline images was not proved. No browser exception or CSP violation was observed. Compose emitted its existing missing Dialog description accessibility warning; compose source was unchanged by this deployment repair. Fresh inline-image upload, real sending/receiving and large-attachment load were not exercised in this acceptance.
- Browser/vault resources created for this task were removed afterward; no account preference or password was changed. Raw evidence is kept under `.tmp/deployment-fixes-20261008/` and the protected release manifest under `.tmp/releases/`.

## Operator setup still required

- Provide the GitHub repository address, then configure environment-scoped Cloudflare API tokens and enable the included verification/deployment/operations workflows. No repository connection or remote workflow execution is claimed.
- Select an independent R2 backup destination and retention policy, and a secret manager for recovery keys. D1 recovery does not recover deleted R2 objects or missing encryption keys. Local recovery files are not an offsite backup.
- Before production acceptance: populate production account/origin/resource configuration, validate code rollback compatibility, real mail/provider failure behavior, large attachment load and safe DLQ redrive.

See [the deployment and recovery runbook](../operations/deploy.md) for commands and failure handling.
