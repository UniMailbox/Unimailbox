# Deployment and recovery runbook

For a new installation, start with [the agent deployment guide](agent-deploy.md):
it covers required inputs, template configuration, initialization, optional
settings and real mail acceptance. This runbook owns release and recovery
behavior. All commands run from the repository root; `pnpm wrangler` resolves
Wrangler-relative config paths inside `apps/worker`.

The release entry point is `pnpm scaffold deploy --environment <environment>`. It uses only `apps/worker/wrangler.<environment>.jsonc`; it never uses the old shared `.cloudflare-resources.json` or generated `.wrangler.resolved.jsonc`. `wrangler.jsonc` is the local build topology, not a release target.

## Toolchain and target

For upstream version notifications and updates to an existing forked
installation, use [the update guide](updates.md). A routine upgrade preserves
the selected account/resources and secrets and does not repeat setup.

Use the exact Node version in `.nvmrc`, pnpm from `packageManager`, and the Worker workspace's pinned Wrangler through `pnpm wrangler`. Install with `pnpm install --frozen-lockfile`; authenticate with `pnpm wrangler login` for a local release. The wrapper runs in `apps/worker`, so relative config/output paths are resolved there; use absolute paths for protected exports elsewhere. CI uses a scoped `CLOUDFLARE_API_TOKEN`.

Production and preview example configs require the operator to choose an account and custom domain, create the canonical configuration from the example and review it before bootstrap. The checked-in staging and production targets belong to the maintainers; they are not defaults for a new user's installation. Names must carry the environment prefix; D1/KV IDs, bucket, queues and secret names must not overlap another environment in the same account. An environment variable cannot override the selected account. Account membership, configured resource identities and active secret metadata are checked before migrations.

The app hostname and mail domain are separate choices. Publishing the custom
domain does not configure incoming MX/routing, create business mailboxes, verify
Brevo senders or prove delivery. Follow the agent guide through setup and live
acceptance before handing over a new service. Dated maintainer deployment records
under `docs/qa/` are evidence for those installations only.

## Bootstrap once

```bash
pnpm scaffold bootstrap --environment staging --dry-run
pnpm scaffold bootstrap --environment staging
```

Bootstrap provisions only absent, explicitly declared resources, resolves D1/KV IDs from fresh list responses and persists them in the canonical config. Its dry run validates the local target and prints a plan; it does not verify remote membership or product availability. It reuses an explicitly selected Secrets Store or the single existing account store, regardless of its name. Ambiguous stores require an explicit ID. Existing active secrets are preserved. Existing inactive or ambiguous secrets fail the operation. Newly created secrets receive up to three metadata checks to allow delayed visibility/activation; confirmation retries never create or rotate another value.

New secret values are passed on stdin and saved first in a protected `.tmp/secret-recovery/<account>/<environment>/` directory (0700 directory, 0600 files). Move these files into the team's secret manager with an independent recovery copy, then securely remove local copies. Never upload this directory as a CI artifact. Existing secret values cannot be recovered through metadata commands.

Bootstrap changes the selected configuration's resolved IDs. Review and commit
those configuration changes before production preparation, which requires clean,
committed release inputs. Local commits are sufficient; no upstream push is
needed. Preserve unrelated work and stage only the reviewed configuration.

## Prepare and publish

```bash
# Full local checks, fresh frontend build, environment-specific Worker dry run.
# No remote writes, resource creation, secret changes or migrations.
pnpm deploy:staging --dry-run

# Publish exactly that source/config/assets identity; use the printed path.
pnpm deploy:staging --prepared .tmp/releases/<account>/staging/<release>/release.json

# Or prepare, check and publish in one invocation.
pnpm deploy:staging
```

The checks run doctor, generated-binding drift detection, lint, TypeScript, all unit/Web/contract/script tests, a fresh build, and all Worker binding tests. Production also requires clean, committed release source. A local account/environment lock prevents overlapping releases on one machine; GitHub Actions serializes the same environment across runners. Local and CI releases must not be run concurrently by operators.

The manifest records Git revision plus a content hash (including dirty staging source), frontend digest, config and migration digests, tool versions, prior Worker version, pre-migration D1 Time Travel bookmark, migration verification and new version. A changed prepared source, config or asset tree is refused. Archive the release directory privately; it contains code and recovery metadata, but no secret values.

Migration history reads fail closed. Only the exact missing `d1_migrations` table is treated as a fresh database. Unknown remote migrations, bad CLI output and failed assertions abort. Pending SQL is applied once; **all read-only schema assertions run on every attempt**, including when no migrations are pending. Legacy fixture writes in 0014/0020 stay in local verification after their explicit delimiter. A SQL history record alone never bypasses a failed verification. There is no `--skip-migrate` or bulk `--force-secrets` escape hatch.

After publication the script checks the configured custom domain: exact Worker version/source identity, dependency readiness and schema, installation status, the current frontend entry, security headers, immutable hashed JS, and 404 for bare `/api`/missing JS/maps. A fresh installation must serve `/setup` and redirect the protected admin route to `/setup`; a completed installation must serve `/login` and return 401 for that route. Passing the fresh-installation smoke does not mean mail is configured. A failed smoke leaves a failed manifest and exits nonzero; publication may already have happened, so inspect the active version before retrying or reverting.

## Secrets and independent rotation

| Binding | Purpose | Rotation |
| --- | --- | --- |
| INSTALLATION_TOKEN | Setup claim token | Explicit named rotation |
| CURSOR_SIGNING_KEY | Inbox cursor HMAC | Explicit named rotation; existing cursors become invalid |
| CREDENTIAL_ENCRYPTION_KEY | Provider credential AES-GCM | Disabled until a tested re-encryption/key-version migration exists |

```bash
pnpm scaffold secret:rotate --environment staging --secret INSTALLATION_TOKEN
pnpm wrangler secrets-store secret list <store-id> --remote --config wrangler.staging.jsonc
```

Rotation resolves the exact remote secret ID and uses `update --secret-id … --remote`; it does not touch other keys. Back up the existing encryption key through the authorized secret-management process **before** deleting/replacing a store. A database backup alone cannot recover encrypted provider credentials without the matching key. Keep historical encryption keys for the lifetime of every backup that references them.

## Rollback and data recovery

Keep schema changes additive and compatible with the previously active Worker. Do not rename/drop/reinterpret existing fields in the same release that introduces their replacement. First add and deploy compatible reads/writes; migrate data separately; remove old schema only after the rollback window and backup retention expire. Review this compatibility before any release with pending migrations; the script cannot infer semantic backward compatibility from SQL.

For a code rollback, read `previousVersion` from the failed release and inspect it:

```bash
pnpm wrangler versions view <previous-version> --json --config wrangler.staging.jsonc
pnpm wrangler rollback <previous-version> --config wrangler.staging.jsonc
pnpm ops:check --environment staging
```

Confirm the older Worker supports the current schema before the rollback command. Worker rollback changes code/assets/bindings configuration; it does not restore D1, R2 bytes or external provider state. Do not blindly re-run the failed release's exact-version smoke against an intentionally older version.

For data recovery, first stop writes and scheduled/queue processing in a planned maintenance window. Record a fresh bookmark/export before any destructive recovery. Restore D1 to the release's pre-migration bookmark only after assessing mail received/sent since that bookmark, provider idempotency and the matching R2/credential-key state. Do not use a production database for a recovery drill.

```bash
pnpm wrangler d1 time-travel info <database-name> --json --config wrangler.staging.jsonc
pnpm wrangler d1 export <database-name> --remote --output <protected-path.sql> --config wrangler.staging.jsonc
# Destructive; substitute only the approved database/bookmark in a maintenance window.
pnpm wrangler d1 time-travel restore <database-name> --bookmark <bookmark> --config wrangler.staging.jsonc
```

D1 Time Travel retention depends on the account plan; confirm it in Cloudflare. It does not back up R2. Retain independent encrypted D1 exports, R2 object backups and the matching secret-manager key versions according to the team's recovery requirements. Never apply a blanket expiry policy to the attachment bucket: it contains active mail, avatars and editor assets. Keep incomplete multipart-upload cleanup; application cleanup owns temporary/unreferenced bytes. Establish external R2 backups and verify object/key/database recovery together before production acceptance.

## Monitoring, DLQ and safe redrive

`/healthz` is liveness and release identity. `/readyz` checks current D1 migration state and readability/format of the three required secrets. `/healthz/maintenance` returns 503 for missing/stale (15 minutes) frequent Cron heartbeat, failed maintenance tasks, any DLQ backlog, or queued/sending D1 jobs created more than 15 minutes ago; updating a retry timestamp cannot hide stalled delivery. It also checks separate hourly (two hours maximum age) and daily (26 hours maximum age) heartbeats. An absent hourly heartbeat is allowed for the first two hours after version creation. An absent daily heartbeat is allowed for the first 26 hours after version creation; an existing failure or stale record is never excused by a new deployment. Local environments without version metadata allow the first daily heartbeat to be absent. The public monitor returns only a boolean, without job IDs, addresses or secret details.

Wrangler configures one `*/5 * * * *` UTC schedule per environment. Each tick runs bounded outbox recovery; only UTC minute zero also expires temporary attachments/editor uploads. Only the 19:00 UTC tick additionally purges expired identity/idempotency records (at most 1,000 per table) and runs avatar, editor and inbound/legacy attachment orphan scans: **once daily at 03:00 Asia/Shanghai**. All three cadences are isolated and have independent heartbeats. Normal sending remains Queue-driven; five-minute scanning increases exceptional recovery latency. The handler temporarily also accepts the previous two-minute expression during trigger propagation. Each R2 orphan prefix scans at most 100 objects per day with durable KV pagination. Grace periods remain 24 hours for avatar/inbound/legacy objects and seven days for editor orphans. Monitor growth before increasing batch sizes. [Cloudflare Cron changes](https://developers.cloudflare.com/workers/configuration/cron-triggers/) can take up to 15 minutes to propagate.

On 2026-10-09 the operator retired legacy `unimailbox` scheduling: its three old Cron expressions were removed and the empty schedule list was read back. Its historical D1/KV data, custom domain and other bindings remain available for the gradual migration; no production cutover or data migration was performed. The BBY Cron belongs to a separate project and is unchanged. The optional GitHub Operations workflow now checks every 15 minutes rather than five; this is separate from Cloudflare scheduling. See [resource reduction QA](../qa/resource-reduction-2026-10-09.md).

Migration 0032 checkpoints successful attachment expiry cleanup in `cleanup_completed_at`. Each frequent tick handles at most 100 pending uploads. The checkpoint follows KV and R2 cleanup, so failed storage/checkpoint writes remain retryable; completed rows are never probed again. Existing upload metadata does not identify its storage backend, and compose can copy legacy KV uploads into R2 before committing, so both stores are checked once for safety. A daily `attachment:` prefix scan catches legacy compose copies that land after expiry cleanup was checkpointed; live uploaded/consumed metadata protects referenced objects and a 24-hour grace protects in-flight writes. Editor assets already have an R2-only expiry path. Authentication lookups retain their existing revocation checks.

```bash
pnpm ops:check --environment staging
pnpm wrangler tail --config wrangler.staging.jsonc
pnpm wrangler queues info unimailbox-staging-outbound-dlq --config wrangler.staging.jsonc
```

Each maintenance task records safe task identity, duration and success. Failures do not prevent other tasks from running; the final `cron.complete` includes cadence and the KV heartbeat records the aggregate result (`ops:cron` for frequent tasks, `ops:cron:daily` for daily scans). A frequent success cannot overwrite a daily failure, and the invocation fails when any task fails. Queue retry exhaustion routes to the environment's separate DLQ. No consumer automatically acknowledges or replays DLQ messages. Inspect queue retention in Cloudflare and respond before it expires. Monitor the scheduled Operations workflow and enable failure notifications for its owners; GitHub schedules can be delayed and are not an availability SLA.

For a DLQ incident, preserve diagnostic evidence, inspect the payload and look up the corresponding D1 job before changing anything. `sent`/terminal jobs must not be reset or resent automatically. Existing stale `sending` leases and orphan `queued` rows are re-enqueued by the Cron reclaim path using the same job IDs. Fix the cause first, let that path recover eligible jobs, and remove only messages confirmed resolved. Poison/unknown payloads require investigation, not blind bulk replay.

## CI activation and troubleshooting

`.github/workflows/ci.yml` verifies pushes/PRs; `secret-scan.yml` checks fetched history with redacted Gitleaks output and narrowly scoped synthetic-fixture exceptions. `deploy.yml` is manual, uses environment concurrency, runs the same entry point and saves private release artifacts for 30 days. Configure GitHub Environments for staging/production, the scoped Cloudflare API token and production protection rules before running deployment. `operations.yml` checks staging every 15 minutes without a Cloudflare token. The workflows are published with the rebuilt source in `UniMailbox/Unimailbox`; a source push runs verification without invoking the manual deployment workflow. Read the exact commit's GitHub Actions result separately from local test evidence. The previous implementation is preserved at `legacy/pre-rebuild-2026-10-10`; its migration chain and deployment workflow are not part of the rebuilt application's environment configs.

A lock remaining after an interrupted process is intentional: confirm its PID is no longer running and no other release is active before removing that specific `.tmp/deployment-locks/<account>-<environment>.lock`. An unknown CLI format, inaccessible resource, stale prepared artifact or failed migration assertion requires investigation; never delete migration history or existing resources to make deployment pass.

## Scheduled-send operations (0033)

Scheduled sends reuse the existing outbound Queue and five-minute recovery
Cron. No new binding or trigger is required. Publish only after migration 0033
and its companion verifier succeed. Existing immediate jobs retain NULL
schedule fields. UTC scheduled times gate the D1 claim, so Queue delay is a
wakeup mechanism rather than the source of truth. Dates beyond Queue's 24-hour
delay window remain in D1 until existing recovery can enqueue them.

Pending jobs pin the same R2 message references as immediate mail; hourly
temporary expiry and daily orphan scanning must retain those references.
Overdue queued/sending jobs still fail maintenance health after the existing
15-minute tolerance; future schedules do not count as stalled. A changed or
cancelled schedule cannot revoke a job already claimed for sending.

Before rolling back to a consumer without scheduled-time claims, cancel or
drain all pending scheduled jobs. A pre-0033 consumer cannot enforce those
timestamps. An additive database migration alone does not make that rollback
compatible.
