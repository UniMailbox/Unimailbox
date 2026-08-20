# Phase 5 — Automation & Multi-Provider

## Business goal

The system supports additional providers and side-effect automations without changing message lifecycle code.

## User value

Operators can switch providers or add automations per their deployment.

## Scope

- **Second provider**: Resend adapter. Tests must pass without changing `SendMessage` use case.
- **Cloudflare Email binding adapter**: if `c.env.email` is configured, register `cf-sendmail` provider.
- **Provider-neutral event mapping**: status application is per-provider in the adapter; use case does not branch.
- **Telegram forwarding**: per-user opt-in; outbound webhook job.
- **AI verification-code extraction**: per-user opt-in; requires Workers AI binding.
- **OAuth (LinuxDo)**: optional; admin can disable.
- **Turnstile**: optional; admin can disable.
- **S3 backend**: optional; admin can configure.
- **Notification subsystem**: simple in-app notifications.
- **Custom domain for R2**: per-deployment.

## Out of scope

POP3/IMAP (separate plan), DMARC/SPF/DKIM tooling, anti-spam.

## Acceptance criteria

```text
[ ] Provider registry holds 3 adapters (Brevo, Resend, CF); no business code branches on provider.
[ ] Adding a 4th provider requires only: new file in integrations/, registry entry, schema.
[ ] Telegram forwarding respects per-user opt-in and survives worker restart.
[ ] AI extraction disabled by default; per-user opt-in only.
```

## Key technical decisions

- Provider plugin shape is fixed: `outbound + webhook + sync + connectionSchema`.
- Telegram bot token encrypted in `encrypted_credentials`.
- OAuth state in KV with 10-min TTL.
- Turnstile verification optional in setup wizard.

## Migration from legacy

- Per-deployment cutover recommended.
- Legacy system archived.

## Risks

- Resend event schema may differ from Brevo.
- AI code extraction may exceed Workers AI rate limits.
- OAuth providers may need different verification flows.
