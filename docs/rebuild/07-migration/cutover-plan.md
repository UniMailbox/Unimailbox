# Cutover Plan

## Definition

**Cutover** is the moment when the new system becomes the production system for a given deployment and the legacy system is archived. This happens at the end of Phase 4, on a per-deployment basis.

## Pre-conditions for cutover

1. **All Phase 0–4 acceptance criteria** pass on a staging deployment.
2. **Migration script** has been dry-run successfully against a copy of the production D1.
3. **Capability ledger** confirms every legacy capability has a new-system implementation (or is explicitly deferred/removed).
4. **Audit log review** confirms no critical issues in last 30 days.
5. **Operator sign-off**.

## Cutover sequence

### Day -7: Pre-flight

- [ ] Snapshot all production D1 databases via Time Travel bookmark.
- [ ] Snapshot all production R2 buckets via `rclone sync` to a cold archive.
- [ ] Snapshot all production KV namespaces via `wrangler kv:bulk get`.
- [ ] Notify operator of cutover window.

### Day -1: Dry run

- [ ] Run the migration script in dry-run mode against a copy of production D1.
- [ ] Verify schema and FK constraints.
- [ ] Verify row counts: users, mailboxes, messages, attachments.
- [ ] Run E2E test against the migrated D1 + new Worker.
- [ ] Roll back the dry run.

### Day 0: Cutover

T-0 (start):
- [ ] Freeze writes to the legacy Worker (set maintenance page).
- [ ] Run the migration script in real mode.
- [ ] Verify the report (rows imported, skipped, failed).
- [ ] Run `pnpm deploy:dry-run` against the new system.
- [ ] Smoke-test the new system (`/health`, `/api/v1/setup/status`, sample user login + password reset).

T+15 min:
- [ ] If smoke tests pass: switch DNS / Worker route to the new system.
- [ ] If smoke tests fail: revert to legacy Worker; legacy is no longer frozen but the migration script changes are reviewed.

T+1 hour:
- [ ] Monitor Worker logs for errors.
- [ ] Monitor D1 query volume.
- [ ] Verify provider webhooks are arriving.

T+24 hours:
- [ ] Review audit log for unexpected state transitions.
- [ ] Verify outbound queue is processing.
- [ ] Verify inbound emails are being received.

### Day +30: Legacy archive

- [ ] Mark legacy Worker as read-only.
- [ ] Set D1 Time Travel bookmark one last time.
- [ ] Notify operator: legacy archived; restore available for 90 days.

### Day +90: Legacy removal

- [ ] Delete legacy Worker.
- [ ] Delete legacy D1 (after explicit operator approval).
- [ ] Delete legacy R2 bucket.
- [ ] Delete legacy KV namespace.

## Password reset requirement

The legacy system uses single-round SHA-256 password hashing. The new system uses PBKDF2-SHA256 with 600k iterations. Legacy password hashes are **not portable** to the new system.

After cutover, users must reset their password on first login. The new system supports this via:

- `POST /api/v1/auth/password/reset-request` (sends a one-time link to email)
- `POST /api/v1/auth/password/reset` (consumes the link, sets new password)

For deployments with Turnstile disabled, the request endpoint is rate-limited by IP.

## Rollback procedure

If cutover fails:

1. **T+0 to T+15 min**: Revert DNS to the legacy Worker. New system is not yet serving traffic. No data loss.
2. **T+15 min to T+24 hours**: Revert DNS to the legacy Worker. New system has data but no traffic. Migration can be reversed via D1 Time Travel.
3. **T+24 hours to T+30 days**: Restore legacy D1 from Time Travel bookmark. New system decommissioned. Outbound queue messages may be lost — recover by re-sending.
4. **T+30 days**: No rollback possible. Forward-fix only.

## Per-deployment cutover

Some operators may want to cut over earlier or later. The plan supports per-deployment cutover:

- Each deployment is identified by its Cloudflare account ID + D1 database ID.
- The cutover sequence runs per-deployment, not globally.
- Operators can defer cutover indefinitely.

## What if a deployment never cuts over?

The legacy Worker continues to run as long as Cloudflare supports the runtime. The new system does not block on legacy cutover. Operators choose when to switch.

## Operator communication plan

| When | What |
|---|---|
| Phase 0 complete | "New repo available; preview deployment is up" |
| Phase 1 complete | "New system supports the full basic flow; ready for limited pilot" |
| Phase 2 complete | "New system is production-ready for new deployments" |
| Phase 3 complete | "New system supports all user-facing features" |
| Phase 4 complete | "Migration script is available; per-deployment cutover can begin" |
| Cutover deadline | "Legacy system will be archived on <date>" |