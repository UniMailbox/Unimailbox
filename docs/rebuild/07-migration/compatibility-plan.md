# Compatibility Plan

## Premise

The rebuild is in a new repository. The legacy system keeps running until per-deployment cutover. This document captures what stays compatible during the window, and what is intentionally incompatible.

## During Phase 0–3 (parallel run)

The new system runs on a **separate route** (preview deployment). The legacy system runs on the **production route**. Users have two URLs:

- `https://mail.example.com/` — legacy
- `https://new.mail.example.com/` — new (preview)

There is **no** session, account, or data sharing between them. A user logging into one does not log into the other.

### What stays compatible

| Artifact | Compatibility |
|---|---|
| Cloudflare account | Same (both Workers may run in one account) |
| Email Routing | Both Workers may receive inbound; the operator configures one Worker at a time |
| Domain DNS | Both URLs resolve; users choose which to use |
| User identity | **Not shared** — users re-register in the new system |
| Email addresses (managed domains) | Same domain can be claimed in both systems, but at different times |

### What is intentionally incompatible

| Artifact | Incompatibility |
|---|---|
| Sessions | New sessions only valid in new system |
| Tokens | New tokens only valid in new system |
| Web clients | Vue (legacy) vs React (new) — different URLs, different builds |
| API contracts | New system uses `/api/v1/*`; legacy uses `/api/*` (no version) |
| D1 schema | New D1 is structurally different from legacy D1 |

## During Phase 4 (cutover)

The operator runs the migration script to copy data from legacy D1 + R2 to new D1 + R2. After cutover:

- Users log in to the new system.
- Users **must reset their password** because legacy passwords are not rehashable.
- Outbound queue is empty (no pending legacy jobs to drain).
- Inbound email routes only to the new Worker.
- Provider webhooks route only to the new Worker.

## API contract stability (within the new system)

The new system's API contract is **stable** from Phase 1 onwards. Any breaking change is a major version bump (`/api/v2`) with a deprecation window.

Within `/api/v1`:

- New endpoints may be added.
- Existing endpoints may add new optional fields in responses.
- Existing endpoints may not remove fields or change semantics.
- Deprecation is signaled via `Sunset` and `Deprecation` headers.

## Client compatibility

There is **exactly one client** in the new system. It is built fresh in the new repo. There is no migration of the existing Vue or React client — the new client is written from scratch against the new API contracts.

The new client shares design tokens with the legacy `DESIGN.md` (OKLCH palette, Geist font, mono numerics, restrained spacing). Beyond that, it is a clean implementation.

## Provider API stability

If a provider changes its event names or payload schema:

1. The adapter for that provider in is is updated.
2. The adapter's contract tests catch the change.
3. The `ProviderPlugin` interface does not change.

## Database migration compatibility

Each D1 migration in the new system:

1. Must be **forward-compatible**: existing reads continue to work after the migration runs.
2. Must be **backward-compatible within the release window**: rolling back the Worker version after the migration does not corrupt data.
3. Must have a paired `.verify.sql` that asserts post-conditions.

Destructive changes (drop column, change type) require:

- A separate later release with explicit operator approval.
- D1 Time Travel bookmark taken before production application.
- Application rollback uses a previous Worker version; database restoration is a separate incident action.

## Session compatibility (within the new system)

- Refresh tokens issued by the new system are valid for 30 days.
- Refresh tokens are rotated on every successful refresh.
- All sessions are revoked on password change or user suspension.

## Configuration compatibility (within the new system)

- `wrangler.jsonc` `vars` block holds non-secret configuration.
- Secrets Store binding holds the encryption keys.
- `encrypted_credentials` table holds encrypted provider credentials.
- `system_settings` table holds runtime configuration.

The new system has no equivalent of the legacy `setting` table (57 columns) or its `wrangler.toml vars` block of secrets. Configuration is structured.

## Communication

For each deployment cutover, the operator is notified:

1. Migration script dry-run results.
2. Migration script real-run results.
3. Cutover window opens.
4. Cutover window closes; new system is live.
5. Legacy archive + 30-day window.
6. Legacy deletion.