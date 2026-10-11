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
2026-10-11. No production Worker release has been published yet. Publication,
application setup, address routing and real delivery must each be verified
separately; no production mailbox or routing cutover is claimed by this record.
The private prepared-release manifest records the exact source and local checks
for the next publication.

The first bootstrap exposed a Secrets Store propagation delay: creation
succeeded before its active metadata was visible. Bootstrap now retries that
metadata read up to three times, without creating or rotating the value again.
Focused deployment tests pass 22/22, including delayed activation and persistent
confirmation failure. Previously created keys were preserved on resume.

## Address cutover

Before changing an address, confirm its local part, mailbox owner, sharing needs
and whether the operator still needs a Gmail copy. `hello@leanda.tech` is the
website's existing destination; other addresses must come from the operator.

1. Finish production setup: create the administrator, register `leanda.tech`
   and configure the existing Brevo account. Provider keys belong in the
   application's encrypted credentials, never in this document or Wrangler vars.
   Do not finalize setup before creating an administrator.
2. Create each confirmed mailbox and any explicit memberships. A global
   administrator does not automatically have access to another user's mail.
3. Add an exact recipient rule that routes the confirmed address to
   `unimailbox-production`. Keep the existing catch-all for other addresses.
   Snapshot the previous rule privately before replacing an existing match.
   Do not route business mail to the staging Worker.
4. Configure a separate authenticated Brevo webhook for the production
   connection. Preserve existing website and staging webhooks. Protect webhook
   credentials and complete attachment download URLs as secrets.
5. With explicitly authorized controlled test recipients, verify inbound storage,
   mailbox visibility, a reply and provider delivery events. Also test a real
   website form submission to the confirmed contact mailbox.
6. If reception fails, restore that recipient's prior rule or remove the new
   exact rule so the existing catch-all handles it. DNS and provider
   authentication do not need to be disabled to roll back an address.

There is no Gmail message import or automatic Gmail-copy feature in this
onboarding procedure. Existing Gmail history remains there until a separate
import or forwarding workflow is requested and verified.

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
