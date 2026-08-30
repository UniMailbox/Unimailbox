# Post-Setup Admin URL Runbook

This runbook is for the operator who finished the setup wizard — either by walking every step or
by using **Skip remaining setup** (CAP-063) — and now needs to know where the remaining
configuration lives.

Read the [Pre-skip warning](#pre-skip-warning) **before** clicking Skip on the Administrator step.

## Pre-skip warning

The **Skip remaining setup** button finalizes the installation immediately. It posts to the same
`POST /api/v1/setup/complete` endpoint the normal Complete step uses, so the installation status
flips to `complete` and the setup wizard locks itself.

**Create the administrator first.** `completeSetup()` grants the `administrator` role to the first
user, if one exists. If no user exists when the installation completes:

- nobody holds the `administrator` role;
- nobody can sign in;
- every admin page below is unreachable, because they all require an authenticated session;
- the setup wizard will not re-open (see [D-CAP-063-A](#known-gaps)), so you cannot go back and
  create the administrator through the UI.

Recovering from that state requires direct D1 database access. To prevent it, the skip button on
`/setup/administrator` is **disabled** until the administrator form has been submitted
successfully. On the five later steps it is always enabled, because reaching them at all means the
administrator already exists.

Skipping is safe with respect to data: it does not delete anything and does not disable any
feature permanently. It only means the domain, Cloudflare Email Routing, and provider steps you
skipped are still unconfigured — see [What still needs configuring](#what-still-needs-configuring).

## Admin URLs

All paths are relative to the deployment origin. Every page requires a signed-in session; the
router redirects anonymous visitors to `/login`. The permission column is the key the **API**
enforces server-side — a signed-in user without it sees a "not authorized" panel rather than data,
because the routes themselves are only session-gated.

| URL | Purpose | Permission | What you can do here today |
|---|---|---|---|
| `/mailbox` | The main mailbox shell — the app itself, not an admin page. | authenticated session | Read, send, and manage messages. |
| `/admin` | Admin landing page. | authenticated session | A static index linking to the four pages below. No configuration happens here. |
| `/admin/connections` | Provider connections (Brevo, Resend, Cloudflare Email). | `webhook_event.read`; the audited secret reveal needs `provider.sync` | Review each connection's provider, status, whether its webhook is configured, and its webhook URL. Reveal a webhook secret behind a confirm dialog — the value is shown **once** and the reveal is written to the audit trail. |
| `/admin/users` | User management. | `user.read` (mutations need `user.manage`) | Page through the user list. |
| `/admin/audit-events` | Audit trail viewer. | `audit.read` | Filter audit events by actor, resource pair, and action, then page with "Load more". Your `setup.complete` row from the skip lands here. |
| `/admin/webhook-events` | Webhook delivery log. | `webhook_event.read` | Review recent deliveries: connection, event type, message, status, timestamp. Metadata only — raw provider payloads are deliberately not shown. |

The seeded `administrator` role holds every permission, so the first user created during setup can
reach all of the above. The seeded `member` role holds `message.{read,send,delete}` and
`mailbox.{create,manage}` only, so members see the not-authorized panel on the admin pages.

## What still needs configuring

If you skipped, these are the wizard steps that did not run. Nothing here is broken — it is
unconfigured, and the symptoms are the normal ones for an unconfigured system.

| Skipped step | Consequence | Where to fix it today |
|---|---|---|
| Domain | No managed domain, so inbound mail has nowhere to route (`R-INBOUND-008`). | No admin page — see [D-CAP-063-B](#known-gaps). D1 access required. |
| Cloudflare Verify | Cloudflare Email Routing is not pointed at this deployment. | The Cloudflare dashboard directly. |
| Inbound Smoke | The inbound path was never proven end-to-end. | Send a real message once a domain and routing exist. |
| Brevo | No outbound provider is connected, so sends fail until one is (`R-OUTBOUND-004`). | `/admin/connections` shows connection state. Creating a connection is currently an API-level operation. |
| Outbound Smoke | The outbound path was never proven end-to-end. | Send a real message once a provider is connected. |

## Known gaps

These admin pages **do not exist yet**. CAP-063 deliberately did not add them; each is tracked as
its own deferral in `docs/rebuild/capability-ledger.md` and needs its own capability. Until then,
each area is reachable only through the API or direct D1 access.

| ID | Missing page | Impact |
|---|---|---|
| `D-CAP-063-A` | Wizard re-entry after `status === 'complete'` | The setup gate hard-locks the wizard on completion. There is no UI path back in, even to fix a step you skipped. A deliberate "re-open setup" action with an audit row and a reason field would close this. |
| `D-CAP-063-B` | Domain management | No UI to add, verify, or delete managed domains. Inbound mail cannot be received until domains exist. |
| `D-CAP-063-C` | Role management | No UI to grant, revoke, or define roles beyond the seeded `administrator` and `member`. |
| `D-CAP-063-D` | Signature management | The `signatures` table exists (CAP-007), but there is no admin page to author or edit signatures. |
| `D-CAP-063-E` | General settings | System-wide knobs (environment, audit retention, and similar) have no UI. |

Look each ID up in the capability ledger for its current status and severity.

## Verifying the installation completed

After a skip, confirm the state flipped:

1. Sign in at `/login` as the administrator you created.
2. You should land in the app rather than being redirected to `/setup`. The setup gate stops
   redirecting once `installation_state.status = 'complete'`.
3. Open `/admin/audit-events` and filter by action. A `setup.complete` row should be present,
   carrying the request ID of the skip request (`R-AUDIT-001`).

If `/setup` still redirects you, the completion did not commit — check the worker logs for the
failed request rather than clicking Skip again.

## Related

- `docs/operations/deploy.md` — provisioning and deploying the worker.
- `docs/rebuild/capability-ledger.md` — authoritative status for every `D-CAP-063-*` gap above.
