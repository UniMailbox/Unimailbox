# J. Risks & Open Questions

This document captures the **risks** we know about and the **questions** we do not yet have answers to. The new repository's Phase 1 implementation does not begin until every open question has at least a recommended default, and the high-severity risks have explicit mitigation plans.

## Premise

The rebuild happens in a new repository. The risks below are split into:

- **New-system risks**: mistakes we might make when building the new repo.
- **Migration risks**: things that might go wrong when importing data from the legacy D1/R2.
- **Cutover risks**: things that might go wrong when an operator flips DNS.

## J.1 Risks (ranked by severity × likelihood)

### New-system risks

#### R1 — Schema drift during new-schema design  — **LOW × MEDIUM**

**Description:** the new D1 schema is designed in isolation. Without legacy-data-shape constraints, we may choose shapes that are elegant but cannot be populated from legacy data.

**Mitigation:**

1. Phase 0 includes a `legacy-schema-snapshot` script that exports a representative legacy D1 to JSON.
2. Before declaring Phase 0 done, every new table is exercised against the legacy snapshot to confirm `INSERT` roundtrip works.
3. Phase 4 migration script is prototyped against the snapshot in Phase 0.

**Decision needed:** none.

#### R2 — Wrangler auto-provisioning and Workers Builds are still evolving  — **HIGH × MEDIUM**

**Description:** the design relies on `wrangler.jsonc` with binding declarations that trigger auto-provisioning of D1, R2, KV, Queue, and Secrets Store. These features shipped in 2025; behavior changes have been observed between Wrangler versions.

**Mitigation:**

1. Pin Wrangler version in `package.json` (`"wrangler": "4.90.0"`).
2. CI runs `pnpm scaffold doctor` against the pinned version.
3. Document a manual fallback (user creates resources in dashboard, fills in IDs).

**Decision needed:** confirm we ship a working manual fallback for users who do not want auto-provisioning.

#### R3 — Performance of Cloudflare Email Routing handler under load  — **MEDIUM × LOW**

**Description:** the legacy handler reads raw bytes via `TextDecoder` chunks and synchronously decodes MIME. The new handler reads raw bytes as `ArrayBuffer` once; under heavy inbound traffic, we want to verify the 30s wall-clock budget is not exceeded.

**Mitigation:**

1. Read raw bytes as `ArrayBuffer` once.
2. Parse MIME async.
3. Write D1 rows in a single batch after R2 uploads succeed.
4. Schedule a single recovery cron for stuck `SAVING` rows.

**Decision needed:** none.

#### R4 — Webhook signing secret rotation  — **MEDIUM × LOW**

**Description:** Brevo allows rotating webhook secrets. The new design stores encrypted secrets; rotation requires dual-secret acceptance during a transition window.

**Mitigation:**

1. Provider connection has a list of valid secrets; webhook verifier tries each in constant time.
2. Setup wizard accepts a new secret; the old is marked `rotating` and expires after 7 days.

**Decision needed:** none.

#### R5 — R2 cost under high attachment volume  — **MEDIUM × MEDIUM**

**Description:** R2 charges per GB-month and per read. If users store many large attachments, costs grow.

**Mitigation:**

1. 64 MiB per attachment limit.
2. Orphan R2 cleanup job.
3. Retention policy: trashed messages → permanent delete after 30 days.

**Decision needed:** confirm retention policy defaults.

#### R6 — D1 row size limits for very large messages  — **MEDIUM × LOW**

**Description:** D1 row size limit is 1 MB. A 2 MB HTML body cannot fit.

**Mitigation:**

1. Cap `htmlBody` and `textBody` at 2 MB each (in zod schema).
2. Larger messages: store body in R2, link via `messages.body_object_key`.

**Decision needed:** what is the cap? (Recommendation: 2 MB.)

#### R7 — State migration from legacy to new during cutover  — **HIGH × MEDIUM**

**Description:** the new schema differs significantly from the legacy schema. Mapping errors cause data loss or unreadable mailboxes.

**Mitigation:**

1. Migration script is idempotent and cursor-based; resumable after crash.
2. Migration script emits a structured report; operator signs off before cutover.
3. Migration script is tested against a fixture dump of legacy data, including edge cases (Unicode, large attachments, missing optional fields, soft-deleted rows).
4. Rollback plan: D1 Time Travel bookmark before cutover.

**Decision needed:** who runs the migration? Operator or new system on behalf of operator?

#### R8 — Security of PBKDF2 with Web Crypto on Workers  — **LOW × LOW**

**Description:** PBKDF2 with 600k iterations may exceed the Workers CPU time budget on slow hardware.

**Mitigation:**

1. Use 600k iterations (modern recommendation; tested on Workers).
2. If too slow: switch to scrypt (not native to Web Crypto) or Argon2 (needs WASM).

**Decision needed:** none until measured.

#### R9 — Logging of sensitive data  — **MEDIUM × LOW**

**Description:** new code logs full error messages and stack traces. Some Brevo errors include recipient addresses.

**Mitigation:**

1. New logger strips known sensitive fields (`password`, `token`, `secret`, `key`, `body`, `html`).
2. CI test asserts logger output for a fixture request containing a password.
3. Provider errors are mapped to `SafeProviderError { code, message }` before logging.

**Decision needed:** none.

#### R10 — Audit log retention  — **LOW × LOW**

**Description:** audit events accumulate forever; D1 storage grows.

**Mitigation:**

1. Retention policy: 90 days for `audit_events`; daily cron prunes.
2. Operators can export to R2 archive bucket.

**Decision needed:** retention default.

#### R11 — Dependency on Cloudflare-specific features  — **MEDIUM × LOW**

**Description:** the new system uses Workers, D1, R2, KV, Queue, Secrets Store, Email Routing, Workers AI. If Cloudflare changes pricing or deprecates a feature, the new system is impacted.

**Mitigation:**

1. Document the dependency list in `docs/operations/dependencies.md`.
2. Maintain a "drop Cloudflare" plan in a separate doc — likely impractical but documented.

**Decision needed:** none.

#### R12 — i18n drift across deployments  — **LOW × LOW**

**Description:** translations may diverge across deployments if operators add their own keys.

**Mitigation:**

1. The i18n catalog is in `packages/contracts` and is the canonical source.
2. Operators may add overrides via `system_settings.i18n_overrides_json`.

**Decision needed:** none.

### Migration risks (Phase 4)

#### R13 — Legacy attachments stored in KV (fallback) not just R2  — **HIGH × MEDIUM**

**Description:** the legacy code falls back to KV storage for small attachments. The new system assumes R2-only.

**Mitigation:**

1. Phase 4 migration script inspects both R2 and KV for legacy attachments.
2. Bytes are copied from KV to R2 under the new key format.
3. Source object is deleted after successful copy.
4. Reports the count of KV-resident attachments in the migration report.

**Decision needed:** none.

#### R14 — Legacy `email.code` column (AI-extracted) contains garbage values  — **LOW × LOW**

**Description:** the legacy `email.code` column may contain incomplete or noisy values from the Workers AI extractor.

**Mitigation:** the new system does not import `email.code`. AI extraction is deferred to Phase 5.

**Decision needed:** none.

#### R15 — Legacy `oauth` rows reference linux.do user IDs that no longer exist  — **LOW × MEDIUM**

**Description:** linux.do user IDs in `oauth.user_id` may point to deleted linux.do users.

**Mitigation:** OAuth is dropped in the new system. Legacy OAuth rows are not imported.

**Decision needed:** none.

#### R16 — Legacy `setting.admin_emails` lists admins that should become the first administrator  — **MEDIUM × LOW**

**Description:** if legacy `setting.admin_emails` is non-empty, those users should become the new system's first administrators.

**Mitigation:** the migration script copies `setting.admin_email` to `installation_state.first_admin_email` and prompts the operator to complete setup for that user (password reset required).

**Decision needed:** none.

### Cutover risks (Phase 4+)

#### R17 — DNS propagation during cutover  — **MEDIUM × MEDIUM**

**Description:** some users may see the legacy system during DNS propagation; others may see the new system. Messages received during the window may go to the wrong Worker.

**Mitigation:**

1. Cutover is per-deployment, with a planned window communicated 7 days in advance.
2. During the window, Email Routing rule points to **both** Workers (with priority order); legacy handles until DNS propagates, new handles after.
3. After 24h, Email Routing rule is updated to point only at the new Worker.
4. Outbound queue is drained before legacy Worker is archived.

**Decision needed:** confirm the dual-target Email Routing rule approach is acceptable.

#### R18 — Password reset required after cutover  — **HIGH × HIGH**

**Description:** legacy password hashes are single-round SHA-256; new system uses PBKDF2. Users cannot log in to the new system with their legacy password.

**Mitigation:**

1. After migration, the user's `password_hash` is `NULL` in the new DB.
2. The new system supports `POST /auth/password/reset-request` (sends one-time link to email).
3. Operator communicates to users: "use the forgot-password link on first login".
4. For deployments with Turnstile disabled, the request endpoint is rate-limited by IP.

**Decision needed:** the email template for the reset link.

#### R19 — Sessions and refresh tokens do not transfer  — **MEDIUM × HIGH**

**Description:** legacy sessions in KV are not readable by the new Worker.

**Mitigation:**

1. After cutover, all users must log in again.
2. The new system issues a new session; legacy sessions are abandoned (they expire naturally within their TTL).

**Decision needed:** none.

#### R20 — Operator forgets to archive legacy  — **LOW × MEDIUM**

**Description:** operators may leave the legacy Worker running indefinitely, accumulating costs.

**Mitigation:**

1. The cutover plan has explicit +30 day and +90 day milestones.
2. The operator receives reminder notifications.
3. Legacy deletion is logged in `audit_events` of the new system.

**Decision needed:** none.

## J.2 Open questions (no answer yet)

### Q1 — Do we ship a single-tenant or multi-tenant deployment model? — **CLARIFIED 2026-10-12**

The deployment is operated by one organization or individual and can serve multiple users, domains and mailboxes. Independent operators deploy independent resources and credentials.

**Current wording:** a self-hosted, multi-user mail application. Mailbox grants and roles define access inside each installation; separate installations do not share a database.

**Decision reference:** the current implementation and deployment guide supersede the original open wording question.

### Q2 — Is LinuxDo OAuth actually used in any deployment?  — **UNKNOWN**

The legacy `oauth-service` supports LinuxDo. We don't know if anyone uses it.

**Recommendation:** **drop in Phase 0**. If someone needs it, re-add in Phase 5 as an opt-in.

**Decision needed:** none if removed; user demand drives Phase 5 work.

### Q3 — Do we need S3 backend in Phase 1, or R2-only?  — **OPEN**

The legacy code supports S3 via aws-sdk; Phase 5 in our roadmap defers it.

**Recommendation:** **R2-only** for Phase 1. The cloud ecosystem already binds R2; S3 adds complexity.

**Decision needed:** none unless users require it.

### Q4 — What is the deployment topology during the dual-run window?  — **UNKNOWN**

Phase 0–3 builds the new system. Does it share a cloud account with the legacy system, or run independently?

**Recommendation:** **separate accounts** for the new system during development. The new system uses the same Cloudflare account name on a preview deployment; legacy keeps the production account. Cutover happens by changing the production account to point at the new system.

**Decision needed:** confirm with the operator that we have a preview account to use.

### Q5 — Is the new client built fresh in the new repo, or do we restart from the existing `mail-react/`?  — **DECIDED**

**Decision:** fresh. The new client is built from scratch in the new repo. It uses the same design tokens and feature boundaries as the legacy `mail-react/` but does not copy source files.

**Decision needed:** none (operator decided).

### Q6 — Should `from-name` be per mailbox or only per user?  — **OPEN**

Legacy has both `account.name` (per mailbox) and `email.name` (per message). The design has `from_name` per message.

**Recommendation:** `from_name` is per-message (the user chooses it at compose time). `mailboxes.display_name` is the default suggestion.

**Decision needed:** none.

### Q7 — Do we keep polling for inbox refresh, or move to push?  — **OPEN**

Legacy uses `setInterval` polling. Cloudflare does not natively support WebSocket push from Worker to browser.

**Recommendation:** keep polling (5 s default, configurable). WebSocket is out of scope.

**Decision needed:** confirm with users.

### Q8 — What is the maximum number of attachments per message?  — **KNOWN**

Design says 10. We keep 10.

### Q9 — What is the maximum message size?  — **KNOWN**

Legacy sends up to 25 MiB (cloudflare Email Routing inbound max). We keep 25 MiB for inbound. Outbound is provider-dependent; Brevo's per-message limit is published as 50 MB but we cap at 25 MiB for parity.

### Q10 — Should `mailbox.share` permission gate member add, or is member add always allowed for the owner?  — **OPEN**

Design has a separate `mailbox.share` permission. Legacy merges it with `account:member:set`.

**Recommendation:** separate `mailbox.share` permission; only the owner or a user with `mailbox.share` (global perm) may add members. Mailbox-admin role inside a specific mailbox does not auto-grant global sharing rights.

**Decision needed:** none.

### Q11 — Are we comfortable dropping LinuxDo OAuth?  — **OPEN**

OAuth users in legacy cannot log in to the new system. If anyone has registered via LinuxDo and expects to log in after cutover, they cannot.

**Recommendation:** **drop LinuxDo OAuth** in Phase 0. Document in migration notes: "If you used LinuxDo, you must register a password in the new system".

**Decision needed:** confirm with operator that no production users depend on LinuxDo.

### Q12 — Should `in_reply_to_header` and `references_header` be relational or text?  — **OPEN**

Design says text. Legacy has text fields concatenated.

**Recommendation:** text. RFC 5322 References can have unbounded length and complex structure; normalizing is over-engineering.

### Q13 — Do we support IMAP/POP3?  — **OUT OF SCOPE**

The `doc/pop3-implementation-plan.md` describes POP3 as a separate gateway. POP3 is a separate workstream from the new system rebuild.

**Decision needed:** none.

### Q14 — Does anyone depend on `/oss/*` static file serving?  — **OPEN**

The legacy code serves static files via `/oss/*`. Removing it could break image references.

**Recommendation:** keep, but auth-gate if sensitive.

**Decision needed:** audit legacy access logs.

### Q15 — Are admin emails hardcoded into wrangler.toml in real deployments?  — **OPEN**

If yes, setup wizard scope may need to change.

**Recommendation:** assume none. Setup wizard creates the first admin.

**Decision needed:** confirm.

### Q16 — What is the actual daily mail volume per deployment?  — **UNKNOWN**

Affects capacity test design in Phase 6.

**Recommendation:** plan for 1k/day per deployment initially. Measure and adjust.

**Decision needed:** none until measured.

## J.3 Decision summary

| Risk / Question | Default decision | Override requires |
|---|---|---|
| R1 schema drift | Phase 0 includes legacy-snapshot test | Data migration requirement |
| R2 Wrangler pinning | Pin 4.90.0 | CI failure or breaking change |
| R3 Email Routing perf | ArrayBuffer read + async parse | Measured bottleneck |
| R4 Webhook rotation | Dual-secret window | Operational requirement |
| R5 R2 cost | 64 MiB cap + retention | Operator budget |
| R6 D1 row size | 2 MB body cap | Need for >2 MB messages |
| R7 Schema mapping errors | Migration script tested against legacy fixture | Edge case uncovered |
| R8 PBKDF2 cost | 600k iterations | Measured too slow |
| R9 Sensitive logs | Strip + CI test | Logging requirements change |
| R10 Audit retention | 90 days | Operator policy |
| R11 Cloudflare lock-in | Document; no mitigation | Cloudflare policy change |
| R12 i18n drift | Operators can override | New language added |
| R13 KV attachments | Migration script copies from KV | Large KV payload |
| R14 email.code garbage | REMOVE in new system | n/a |
| R15 OAuth rows | OAuth dropped | n/a |
| R16 Legacy admin emails | Migrated as `first_admin_email` | n/a |
| R17 DNS propagation | Dual-target Email Routing during window | Operator policy |
| R18 Password reset | Required; reset link sent via email | Email template change |
| R19 Sessions don't transfer | Users re-login | n/a |
| R20 Legacy not archived | Reminders at +30 / +90 days | n/a |
| Q1 Multi-tenant | Single-tenant | Re-read PRODUCT.md |
| Q2 LinuxDo OAuth | Drop in Phase 0 | Real production users |
| Q3 S3 backend | R2-only Phase 1 | User demand |
| Q4 Deployment topology | Separate account for new system | Shared infra constraint |
| Q5 mail-react canonical | Fresh build in new repo | (decided by operator) |
| Q6 From-name semantics | Per-message | UI confusion |
| Q7 Inbox refresh | Polling 5s | Provider supports push |
| Q10 Sharing perm | Separate `mailbox.share` | Conflict with design |
| Q11 LinuxDo drop | Drop in Phase 0 | Real production users |
| Q14 `/oss/*` | Keep, auth-gate | Real usage |

## J.4 The "stop-the-line" conditions

If any of these become true during implementation, we pause and re-plan:

1. **A user is locked out of their data** during migration or cutover.
2. **A measured benchmark shows the new Worker exceeds the 30s wall-clock budget** under realistic load.
3. **A schema migration causes irreversible data loss** in the new D1.
4. **The Brevo adapter fails in a way that loses messages.**
5. **The setup wizard allows installation to complete without a working smoke test.**
6. **The audit log reveals unauthorized access** to messages or credentials.
7. **A new business requirement arrives** that does not fit any current phase.

For each, the response is: stop, document, escalate to the operator, do not resume until the operator signs off.
