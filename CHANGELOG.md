# Changelog

All notable changes to UniMailbox are documented here. The project follows
[Semantic Versioning](https://semver.org/) and uses
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories. Release
Please updates released sections from Conventional Commits.

## [Unreleased]

### Added

- AGPL-3.0-only open-source licensing and contributor/security policies.
- Stable distribution, installation adoption, protected production deployment,
  and daily upstream upgrade documentation.
- Domain-level Brevo or Resend provider selection, administrator test delivery
  to a chosen recipient, and managed-domain attribution for provider webhooks.

### Fixed

- First-time Deploy Button installations now provision Cloudflare resources
  with a credential-free minimal deployment. Migrations, administrator setup,
  and runtime secrets use a separate explicit bootstrap command, while release
  verification remains deferred until adoption.

## [M1 MVP] — 2026-08-09

The smallest thing a human can verify end-to-end. The blueprint
(`docs/architecture/mvp-blueprint.md`) freezes the kept surface; everything
else is dormant until the next milestone.

### User-visible changes

- Single-role administrator login (`/api/v1/auth/register` + `/login`)
  issues an access token and refresh cookie; `/api/v1/auth/session`
  echoes the principal.
- Mailbox list / create / detail with rename + delete.
- Send / receive via `POST /api/v1/messages/send` and the
  `POST /api/v1/webhooks/:providerKey/:connectionId` inbound path.
- Inbox read / star / move / delete from
  `PATCH /api/v1/messages/:id/{read,star,folder}`.
- Admin console exposes only Domains, Audit Events, and System Settings;
  every other tab is unrouted.
- Manual verification gates (`docs/architecture/mvp-blueprint.md` §5)
  cover bootstrap, admin login, domain provisioning, send + receive,
  message-state mutations, audit visibility, and request-id propagation.

### Sub-issues

- #14 baseline freeze, #15 permissions cut, #16 RBAC seed trim,
  #17 bootstrap gate, #18 migrations 0011 mvp minimum, #19 router gating,
  #20 entrypoint trim, #21 web trim, #22 docs close-out.
- Dormant until M2: #23..#30 (cleanup, scheduled send, signatures,
  member role, provider connections, attachment dedup, etc.).

[Unreleased]: https://github.com/UniMailbox/uni-mailbox/commits/main
[M1 MVP]: https://github.com/UniMailbox/uni-mailbox/compare/12c0b71...HEAD
