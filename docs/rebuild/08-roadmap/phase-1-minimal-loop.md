# Phase 1 — Minimal Business Closed Loop

See `../H-progressive-rebuild-roadmap.md` and `../F-minimal-business-closed-loop.md`.

**Status (2026-08-13):** Code complete and quality-gate verified. Audit: `../phase-1-audit.md`.

## Business goal

An admin can install, claim a domain, connect Brevo, invite a user, and that user can read a real inbound email and reply.

## User value

End-to-end mail flow works for the first tenant (typically a pilot deployment).

## Scope

- Modules: `identity`, `onboarding`, `tenancy`, `messages`, `inbound-mail`, `outbound-mail`, `admin/installation`, `admin/audit`.
- Full setup wizard (steps 3–9): administrator, cloudflare (dashboard-assisted mode), domain, inbound smoke test, brevo, outbound smoke test, complete.
- Authn + Authz middleware.
- Mailbox CRUD (owner only — no sharing yet).
- Inbox list, message detail, read state, basic delete.
- Compose + send with provider registry (Brevo only).
- Outbound queue + consumer + dispatcher recovery cron.
- Webhook ingest (Brevo) + delivery idempotency + status application.
- Admin pages: users (list only), webhook events (read-only).
- Audit event emission on every state transition.

## Out of scope

Mailbox sharing, drafts, stars, archive/trash, attachments beyond simple inline, signatures, server drafts, search, bulk admin operations, provider sync, Resend/CF providers, Telegram, AI, S3, OAuth, Turnstile, analytics.

## Acceptance criteria (29 boxes)

Authoritative list: `../F-minimal-business-closed-loop.md` §F.4. The 27-step §F.1 loop is the
behavioural specification; the 29 acceptance boxes are the mechanical gates. Resolves
discrepancy D-1 (this file previously said "23 boxes").

## Key technical decisions

- **Provider registry**: in `integrations/providers/brevo/` only.
- **Outbound queue**: Cloudflare Queue binding `OUTBOUND_QUEUE`.
- **Dispatcher cron**: every minute.
- **Webhook idempotency**: `webhook_deliveries` table with 60s lock TTL.
- **Audit events**: written on every state transition + admin action.

## Migration from legacy

- The new repo runs on a **separate route** from the legacy system.
- The legacy system continues serving its users on its route.
- The single web client is the one built in the new repo (React + shadcn/ui).
- No data migration in Phase 1.

## Risks

- Brevo API rate limits during smoke tests.
- Cloudflare Email Routing may need manual DNS verification during setup.

## Tests required

- Domain tests: state machine transitions.
- Integration tests: Brevo mock + Worker pool; full inbound → outbound round trip.
- API contract tests: every `/api/v1/*` route exercised.
- One E2E test: register → mailbox → inbound → reply.

## Verification status

| Gate | Status | Notes |
|---|---|---|
| `pnpm typecheck` | ✓ | zero errors |
| `pnpm lint` | ✓ | zero warnings |
| `pnpm test:unit` | ✓ | 232 / 232 (12 files) |
| `pnpm test:worker` | ✓ | 348 / 348 (26 files) |
| `pnpm build` | ✓ | worker + web |
| `pnpm scaffold doctor` | ✓ | 10 / 10 |
| §F.4 29 boxes | ✓ | each mapped to an artifact |
| Operator preview deploy | pending | owner of `Verified` status in the ledger |

## Known Phase 1 limitations (not blocking `Implemented`)

- `message_user_state` PK is `(mailbox_message_id)`; multi-user read-state independence is best
  effort. Schema fix is a future capability.
- Compose endpoint does not enforce `Idempotency-Key` (R-OUTBOUND-005). Deferred to CAP-027.
- `apps/web/` is a TanStack Router stub with `/` and `/setup` only. The 27-step backend loop is
  verified end-to-end via worker-pool tests; the React feature pages (`/inbox`, `/admin`,
  `/compose`, `/admin/webhook-events`) are a follow-up capability once the operator is ready to
  drive the UI.