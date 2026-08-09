# Cloud Mail — M1 MVP Blueprint

> **Status:** approved (M1 cut merged on 2026-08-09, commit `aac305f`+`12c0b71`; PR #35 (#19/#20/#21) awaiting manual merge).
>
> **Owner:** core platform. Changes to §1..§4 require a fresh issue. Changes to
> §5 (verification gate ticks) are reviewer-initiated once the manual walkthrough
> completes.

This blueprint freezes what ships in M1 ("the smallest thing a human can verify
end-to-end"). It defines the *kept* surface that survives in code, the *cut*
surface that lives only as dormant schema / routes / modules, and the manual
verification gates a reviewer walks through before declaring M1 shippable.

## §1 — Module cut table

| Surface | State | Notes |
| --- | --- | --- |
| Admin login + session | ✅ kept | `apps/worker/src/modules/identity/*` |
| Mailbox list / create / detail / rename / delete | ✅ kept | `apps/worker/src/http/router.ts` |
| Send / receive (single-role) | ✅ kept | webhook + `messages.send` |
| Message read / star / move / delete | ✅ kept | per-message patch routes |
| Admin → Domains | ✅ kept | `apps/web/src/features/admin/AdminPage.tsx` |
| Admin → Audit Events | ✅ kept | minimal list endpoint |
| Admin → System Settings | ✅ kept | `apps/worker/src/modules/administration` |
| Drafts UI | 🛑 cut (schema kept) | `0011_mvp_minimum.sql` keeps `drafts` table; router drops the routes |
| Attachment upload UI | 🛑 cut (schema kept) | `attachment_uploads` / `message_attachments` / `attachment_files` live on |
| Shared mailbox UI | 🛑 cut (schema kept) | `MailboxMembers` component remains, JSX-gated to false |
| Domain signatures UI | 🛑 cut | editor lives in `AdminPage.tsx`, gated to "signatures" resource (unrouted) |
| Storage / Cloudflare admin tabs | 🛑 cut | `CloudflareSettings` / `StorageSettings` lazy imports retained |
| Analytics / MCP admin tabs | 🛑 cut | module + tables present, unrouted |
| Cron-driven maintenance | 🛑 cut | `entrypoints/scheduled.ts` rewritten as no-op (issue #20) |
| Agent / MCP factory | 🛑 cut | not wired into `appContext` (issue #20) |
| Integrations (Brevo / Resend) | 🛑 cut from runtime path | `ProviderRegistry` still constructed for settings writes |

## §2 — Kept HTTP surface

See `apps/worker/src/http/router.ts`. M1 routes are exactly:

- `GET /health`
- `GET /setup` (redirects to `/login`)
- `POST /api/v1/webhooks/:providerKey/:connectionId`
- `POST /api/v1/auth/register` / `login` / `refresh` / `logout`
- `GET /api/v1/auth/session` (auth required)
- `GET|POST /api/v1/mailboxes`, `GET|PATCH|DELETE /api/v1/mailboxes/:id`
- `GET /api/v1/mailboxes/:id/messages`
- `POST /api/v1/messages/send`, `GET|PATCH|DELETE /api/v1/messages/:id`,
  `PATCH /api/v1/messages/:id/{read,star,folder}`
- `GET|POST /api/v1/admin/domains`, `GET /api/v1/admin/domains/:id`
- `GET|PATCH /api/v1/admin/system-settings`
- `GET /api/v1/admin/audit-events`

## §3 — Dormant schema kept

- `drafts` / `scheduled_send_jobs` (issue #28)
- `attachment_uploads` / `message_attachments` / `attachment_files` (issue #27)
- `signatures` (issue #30)
- `user_mailbox_access` (issue #23)
- `provider_connections`, `webhook_deliveries` (issue #25)

`0011_mvp_minimum.sql` is the schema-level cut: it drops triggers + indexes
and clears `attachment_files` while leaving the dormant columns
(`file_id`, `md5`, `created_via_schedule`) in place so M6 / M7 callers can
revive them without further schema work.

## §5 — Verification gates (M1 manual walkthrough)

The reviewer ticks each box once the manual walkthrough completes. The
"pending reviewer" placeholder is replaced with initials + ISO date.

### §5.1 — Bootstrap

- [ ] pending reviewer YYYY-MM-DD — `./scripts/migration.mjs apply --local`
      seeds all 11 migrations cleanly.
- [ ] pending reviewer YYYY-MM-DD — first-time deploy boots the worker
      without missing-binding warnings.

### §5.2 — Admin login

- [ ] pending reviewer YYYY-MM-DD — `POST /api/v1/auth/register` creates the
      bootstrap administrator.
- [ ] pending reviewer YYYY-MM-DD — `POST /api/v1/auth/login` returns an
      access token + refresh cookie; `GET /api/v1/auth/session` echoes the
      principal.

### §5.3 — Domain provisioning

- [ ] pending reviewer YYYY-MM-DD — `POST /api/v1/admin/domains` creates a
      domain and the response includes routing guidance for Cloudflare.

### §5.4 — Send + receive

- [ ] pending reviewer YYYY-MM-DD — sender mailbox + recipient mailbox both
      visible after `POST /api/v1/mailboxes` (×2).
- [ ] pending reviewer YYYY-MM-DD — `POST /api/v1/messages/send` produces a
      row in `outbound_jobs` (status `pending` → `sent`).
- [ ] pending reviewer YYYY-MM-DD — triggering the mocked webhook delivers
      the message into the recipient inbox (`GET /api/v1/mailboxes/:id/messages`).
- [ ] pending reviewer YYYY-MM-DD — message detail loads
      (`GET /api/v1/messages/:id`).

### §5.5 — Read / star / move

- [ ] pending reviewer YYYY-MM-DD — `PATCH /api/v1/messages/:id/read` flips
      the read state visible in the inbox.
- [ ] pending reviewer YYYY-MM-DD — `PATCH /api/v1/messages/:id/star` flips
      the star state.
- [ ] pending reviewer YYYY-MM-DD — `PATCH /api/v1/messages/:id/folder` moves
      the message into archive / trash and back.

### §5.6 — Admin audit + settings

- [ ] pending reviewer YYYY-MM-DD — `GET /api/v1/admin/audit-events` lists
      the events emitted by the walkthrough.
- [ ] pending reviewer YYYY-MM-DD — `PATCH /api/v1/admin/system-settings`
      persists a change (`outbound_enabled`) and `GET` reflects it.

### §5.7 — Errors carry request IDs

- [ ] pending reviewer YYYY-MM-DD — every 4xx response carries
      `x-request-id` matching the inbound `cf-ray` (or a UUID fallback).

## §6 — Milestone ledger

| Milestone | Status | Merged | PRs |
| --- | --- | --- | --- |
| M1 MVP | ✅ cut merged | 2026-08-09 | — |
| M1 MVP | 🟡 router trim | branch `chore/issue-19-router-mvp-gate` | PR #35 (#19) |
| M1 MVP | 🟡 entrypoint trim | branch `chore/issue-19-router-mvp-gate` | PR #35 (#20) |
| M1 MVP | 🟡 web trim | branch `chore/issue-19-router-mvp-gate` | PR #35 (#21) |
| M1 MVP | ✅ migrations | 2026-08-09 | PR #34 (#18) |
| M1 MVP | ✅ bootstrap gate | 2026-08-09 | PR #33 (#17) |
| M1 MVP | ✅ RBAC seed | 2026-08-01 | PR #32 (#16) |
| M1 MVP | ✅ permissions cut | 2026-08-01 | PR #31 (#15) |
| M2 Cleanup backlog | ⏳ pending | — | issue #28 |
| M2 Scheduled send | ⏳ pending | — | issue #29 |
| M2 Domain signatures | ⏳ pending | — | issue #30 |
| M2 Member role | ⏳ pending | — | issue #23 |
| M2 Provider connections | ⏳ pending | — | issue #25 |
| M6 Attachment dedup | ⏳ pending | — | issue #27 |

## §8 — Sub-issue index

The M1 cut was tracked as 17 issues on GitHub. Each maps to a verification
gate row in §5:

| Issue | Title | PR | Unblocks §5 gate |
| --- | --- | --- | --- |
| #14 | baseline freeze | n/a (process) | §5.1 |
| #15 | contracts trim role grants to 5 keys | PR #31 | §5.2 |
| #16 | migrations trim RBAC seed | PR #32 | §5.2 |
| #17 | migrations skip configuration_checkpoints seed | PR #33 | §5.1 |
| #18 | migrations 0011 mvp minimum | PR #34 | §5.1, §5.4 |
| #19 | router gates to M1 surface | PR #35 | §5.2..§5.6 |
| #20 | entrypoint mount/unmount to MVP set | PR #35 | §5.1 |
| #21 | web trim to MVP surface | PR #35 | §5.4, §5.5 |
| #22 | docs close-out + freeze blueprint | this file | §5.7 |
| #23..#30 | M2+ backlog | not started | n/a |