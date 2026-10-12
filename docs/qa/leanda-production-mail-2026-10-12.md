# Leanda production mail — 2026-10-12

Scope: initialize the independent Leanda production installation, receive all
domain addresses under one admin, and preserve the previous Gmail copy.
No legacy/staging database, website source or existing provider webhook was
changed. Gmail history was not imported.

## Published release

- Portal: `https://mail.leanda.tech`; Worker: `unimailbox-production`.
- Source revision: `7599e03820ec28c37dc3dec4522fc45d8a161fbe`.
- Source tree: `8a2b37c08f8e6d97ac86feb2a2c1cad04696bcad063e2be5f236f6fab53c1a7c`.
- Worker version: `e765cc40-f059-453d-8654-8dffc620e0bb`.
- Canonical prepared production release passed doctor 14/14, binding drift,
  lint, TypeScript, builds and 2,229 tests: 1,266 unit/Web/contract/script,
  941 Worker and 22 migration fixture tests. The 46 focused deployment/inbound
  tests are included in these totals. Staged Gitleaks found no leaks.
- All 33 migrations were applied to the independent production D1 database;
  all 33 read-only migration assertions passed. Both fresh setup and completed
  installation publication smoke passed with the exact version/tree, frontend,
  security headers, immutable asset, missing paths and protected API checks.
- `/readyz` reports schema 0033; `/healthz/maintenance` reports `ok: true`.
  The production configuration retains the single five-minute Cron.

## Configuration and ownership

The sole application user is `admin@leanda.tech`, with the administrator role.
Admin owns the active `admin@`, `hello@` and `johnjiang@leanda.tech` mailboxes;
the live admin API reports one user and three accessible mailboxes. Default
mailbox is `admin@leanda.tech`, with Chinese selected for that user.

Cloudflare's live catch-all now targets `unimailbox-production`. Before the
mutation, the prior rule was compared against its private snapshot and the
existing Gmail destination was confirmed verified. The same destination is
installed as private Worker secret `INBOUND_FORWARD_TO`; production's public
catch-all mailbox setting is `admin@leanda.tech`. The unregistered acceptance
address did not create a fourth mailbox. MX/SPF/DKIM/DMARC were preserved.

The existing Brevo key was validated and stored through setup as an encrypted
credential. All three domain sender addresses are active in Brevo. A separate
production webhook uses an Authorization Bearer header and an independent
connection secret. Initial webhook secret provisioning used a guarded D1 update
for this new connection and a `webhook_secret.configure` audit operation;
the current setup/reveal flow does not generate an absent key. The admin reveal
API subsequently verified that value. Existing webhook credentials were not
rotated or replaced.

## Controlled live delivery

Only admin-owned Leanda recipients were used for these three messages:

1. Send from `johnjiang@leanda.tech` to `hello@leanda.tech` through the production
   compose API, D1 outbox, Queue and Brevo. Exactly one matching inbound record
   appeared in the hello inbox with the expected sender, recipient and body.
2. Send through that same pipeline to one unregistered `leanda.tech` address.
   Exactly one matching inbound record appeared in the admin inbox with the
   original address retained, and mailbox count stayed at three.
3. Reply from the hello mailbox to `johnjiang@leanda.tech` using the received
   Message-ID. The John inbox received the expected body and matching
   In-Reply-To header. Brevo's actual authenticated delivery callbacks advanced
   all three outbound messages to `delivered`.

The browser was signed into the existing Gmail destination. Its focused test
search visibly showed both initial controlled messages in Inbox, confirming
actual receipt of the retained copies. This was a real Gmail browser check;
the connected Gmail API profile belonged to a different account and was not
used to infer receipt. No unrelated messages were opened or changed.

Wrangler downloaded the two controlled raw MIME objects from production R2.
Both contained the expected subject and body; sizes were 5,816 and 5,948 bytes.
The production mailbox APIs separately verified their parsed contents.

## Evidence and remaining boundaries

Release manifest and migration receipts remain in the ignored production
release directory. Private routing snapshots, provider configuration, raw MIME,
initial administrator credentials and API sessions remain under
`.tmp/leanda-mail-20261012/`, with directory mode 0700 and secret files 0600.
Passwords, provider keys, forwarding addresses, webhook tokens and raw private
snapshots are not part of this record or Git.

This verifies the scoped domain cutover, controlled send/receive/reply, R2 raw
storage, Gmail copies and real provider delivery events. A real website contact
form submission, Gmail history import, comprehensive application acceptance,
large-attachment production retesting and sustained-load testing were not run.
The live website's contact destination remains `hello@leanda.tech`; its visible
form was inspected without submitting it. Staging still served version
`155d261d-c109-454b-91ab-440b59d3b07e` at the post-cutover check.
