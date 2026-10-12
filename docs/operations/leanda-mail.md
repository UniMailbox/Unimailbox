# Leanda mail onboarding

This record tracks the production deployment and the separate cutover of
`leanda.tech` mail. It does not replace the [release runbook](deploy.md).

## Domain audit — 2026-10-11

- Cloudflare owns the active `leanda.tech` zone. Email Routing is enabled,
  synchronized and ready; the existing catch-all forwards to the operator's
  Gmail inbox. No address-specific Worker rule exists at this audit point.
- Public MX records already use Cloudflare. Preserve their existing priorities
  and the single SPF record, `v=spf1 include:_spf.mx.cloudflare.net ~all`.
- Brevo's domain API reports `verified: true` and `authenticated: true`.
  The `brevo1._domainkey` and `brevo2._domainkey` CNAME records, verification
  TXT record and existing DMARC record all pass Brevo's checks. The existing
  `em.leanda.tech` return-path/tracking configuration remains in use.
- The website contact endpoint sends to `hello@leanda.tech` through Brevo and
  sets the visitor as Reply-To. The deployed `leanda-tech` Worker already has
  Brevo and Turnstile runtime secret bindings. Secret presence is metadata,
  not proof that a real form submission delivers successfully.
- `mail.unimailbox.tech` still serves the legacy Worker. The rebuilt application
  is currently verified on staging. Never apply the rebuilt migrations to the
  legacy `unimailbox` database.

## Production target

The initial portal is `https://mail.leanda.tech`, configured in
`apps/worker/wrangler.production.jsonc`. Worker, D1, R2, two KV namespaces,
outbound queue, dead-letter queue and three named secrets use independent
`unimailbox-production` identities. Staging and legacy resources remain separate.
The existing single Cron trigger and daily file maintenance policy apply.

Production resources and all three active secrets were provisioned on
2026-10-11. Domain-wide routing and a retained Gmail copy were authorized on
2026-10-12. Production publication, admin setup and controlled send/receive/reply
acceptance completed on 2026-10-12, including actual Gmail receipt and R2 raw
storage. See [live acceptance](../qa/leanda-production-mail-2026-10-12.md) for
the exact release identity and verification boundaries. Staging and legacy
resources remain separate.

## Address routing and ownership

Only the initial `admin@leanda.tech` application user will use this installation.
Create `admin@leanda.tech`, `hello@leanda.tech` (the website contact destination)
and `johnjiang@leanda.tech` as mailboxes owned by that user. Set the default
mailbox to `admin@leanda.tech`; other addresses need no pre-created mailbox to
receive mail.

Production sets `INBOUND_CATCH_ALL_MAILBOX=admin@leanda.tech`. Existing active
mailboxes receive their own envelope addresses first; other `leanda.tech`
addresses enter the admin mailbox. Disabled/deleted exact addresses remain
rejected locally. Foreign domains never use this fallback. The actual envelope
address is retained as a Bcc recipient when absent from the sender's To/Cc
headers. Arbitrary addresses do not create database rows, users, memberships,
new Cron jobs or background scans. Sending from another address requires an
explicit mailbox owned by admin through the existing mailbox creation flow.

Set `INBOUND_FORWARD_TO` as a private Worker secret to the previous verified
Gmail destination, never as a committed Wrangler var. The Worker awaits the
Cloudflare forward before parsing, local policy or persistence so the previous
Gmail copy is retained even if local processing subsequently rejects the mail.
Invalid configuration or same-domain forwarding fails closed. A forwarding
failure prevents persistence and surfaces the error; a later storage failure
can produce another Gmail copy on retry. Forwarding and R2/D1 cannot provide an
atomic, exactly-once transaction. Existing Gmail history stays in Gmail.

## Production cutover

1. Publish through the canonical production release command. A fresh
   installation smoke checks `/setup` and its protected API redirect. It does
   not prove configured mail delivery.
2. Claim setup with the private installation token, run preflight, create the
   administrator, register `leanda.tech` and configure the existing Brevo
   account. Provider keys are encrypted by the application. Complete setup
   only after the administrator exists. Create the three admin-owned mailboxes
   and select the admin default mailbox.
3. Install the private forwarding secret through Wrangler, confirm that the
   original Gmail destination is still verified, and check the live release
   and dependencies before changing routing.
4. Preserve the original Cloudflare catch-all privately and compare its live
   state immediately before changing it to `unimailbox-production`. Preserve
   existing MX, SPF, DKIM, DMARC and the website/staging provider configuration.
5. Configure a separate authenticated Brevo webhook for the production
   connection. Preserve existing website and staging webhooks. Protect webhook
   credentials and complete attachment download URLs as secrets.
6. Send controlled messages to an explicit mailbox and an unregistered domain
   address; check mailbox ownership, original envelope identity, R2 storage,
   Gmail forwarding and an outbound reply/provider event. A real website form
   submission is a separate acceptance boundary.
7. If actual reception/forwarding fails, restore the saved catch-all action
   immediately. Do not disable DNS or provider authentication for rollback.

Focused tests cover domain isolation, exact mailbox precedence, disabled
mailboxes, retained envelope identity, forwarding failures and loop prevention.
Deployment script tests cover both fresh and completed installation gates.
The scoped live cutover acceptance passed on 2026-10-12. A real website contact
form submission and the comprehensive application acceptance catalog were not
run as part of this cutover. Initial webhook provisioning required an audited,
guarded D1 initialization for the new connection because setup/reveal currently
does not generate an absent webhook key; it preserved all existing keys.

## Credential handling

Bootstrap recovery files and private audit snapshots live only in the ignored
`.tmp/` tree, with restrictive permissions. Transfer the production recovery
keys to the operator's secret manager before removing those local files;
particularly preserve the credential encryption key. Never publish passwords,
API keys, setup tokens, raw audit snapshots or private email contents.

Wrangler OAuth can read and manage Email Routing here. The general DNS-records
API currently returns 403 for this credential. If additional DNS changes become
necessary, use the Cloudflare dashboard or a narrowly scoped DNS credential;
do not request a global API key. Existing mail DNS already passes the relevant
checks, so no DNS rewrite is required at this stage.
