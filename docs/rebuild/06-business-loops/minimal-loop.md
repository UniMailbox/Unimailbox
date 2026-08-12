# Minimal Business Closed Loop

See `../F-minimal-business-closed-loop.md` for the full vertical slice. This document is a summary.

## 22-step slice

1. Operator installs via "Deploy to Cloudflare" button.
2. Operator visits Worker URL → redirected to /setup.
3. Operator pastes INSTALLATION_TOKEN → setup session in KV.
4. Operator completes preflight (verify D1, R2, KV, Queue bindings).
5. Operator creates the first administrator.
6. Operator adds a managed domain (manual DNS note shown).
7. Operator configures Email Routing rule pointing at the Worker.
8. Operator triggers inbound smoke test.
9. Operator completes setup → all routes except /setup are now accessible.
10. Admin issues one registration key.
11. New user registers with that key.
12. User logs in.
14. User creates a mailbox (admin@domain.com).
15. External sender mails admin@domain.com.
16. Worker parses MIME → Message + MailboxMessage rows exist in D1.
17. User opens /inbox → sees the message.
18. User opens the message → reads it (isRead=true).
19. User clicks Reply → compose drawer opens with quoted text.
20. User sends → OutboundJob created → queue consumer calls Brevo.
21. Brevo accepts → Message.status = 'sent'.
22. Webhook arrives → Message.status = 'delivered'.
23. Admin opens /admin/webhook-events → sees the delivery event.

## Capability ledger (Phase 1 only)

32 capabilities, all required. See `F.4` for the full list.

## What is NOT in Phase 1

20+ deferred features. See `F.3`.

## Acceptance criteria (23 boxes)

See `F.4` — full exit criteria for Phase 1.

If any box does not check, Phase 1 is not done. We do not advance.