# Complete Business Loop

The complete loop expands the minimal loop with Phases 2–6. By Phase 6, the system supports:

- Full draft lifecycle (Phase 3)
- Mailbox sharing with per-user read/star/delete (Phase 3)
- Server-authoritative attachments with auth (Phase 3)
- Search, bulk operations, provider sync (Phase 4)
- Multiple providers (Brevo + Resend + CF) (Phase 5)
- Telegram forwarding, AI code extraction (Phase 5)
- OAuth, Turnstile (Phase 5)
- Performance under load (Phase 6)

## Layered expansion

```text
Phase 1 — minimal loop (Brevo only, single-user mailboxes, no drafts)
        ↓
Phase 2 — idempotency + retry + audit (still single-user)
        ↓
Phase 3 — sharing + drafts + attachments (per-user state)
        ↓
Phase 4 — search + bulk + provider sync (admin tooling)
        ↓
Phase 5 — multiple providers + Telegram + AI + OAuth
        ↓
Phase 6 — performance + caching + observability depth
```

## Capability ledger (target end state)

| Capability | Phase |
|---|---|
| Setup wizard | 0 |
| Authn (PBKDF2 + session rotation) | 0 |
| Send message (Brevo only) | 1 |
| Receive message | 1 |
| Reply with threading | 1 |
| Webhook ingest + status | 1 |
| Audit log | 1 |
| Idempotency on send | 2 |
| Outbox + queue retry | 2 |
| Attachment upload + send | 3 |
| Server drafts | 3 |
| Mailbox sharing | 3 |
| Per-user read/star/delete | 3 |
| Search | 4 |
| Bulk operations | 4 |
| Provider sync (Brevo) | 4 |
| Provider switch (Resend, CF) | 5 |
| Telegram forwarding | 5 |
| AI code extraction | 5 |
| OAuth (LinuxDo) | 5 |
| Turnstile | 5 |
| S3 backend | 5 |
| ECharts analytics | 4 |
| Caching layer | 6 |
| Performance budget | 6 |

## What stays minimal forever

Even after all phases:

- **No** generic plugin system.
- **No** arbitrary event bus.
- **No** external workflow engine.
- **No** multi-tenant isolation beyond per-deployment boundaries.
- **No** dynamic configuration (everything is code-or-config).
- **No** microservice decomposition.

These were never part of the value stream. Adding them would inflate complexity without adding business value.