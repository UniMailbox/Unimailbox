# CAP-025 — Admin webhook events view

**Phase:** 1 · **Status:** In Progress

## Goal

An admin can view webhook delivery events and provider connection info (including the webhook URL and signing secret for operator configuration).

## Scope

- **Admin webhook routes** (`http/routes/admin-webhooks.ts`): `GET /api/v1/admin/webhook-events` (list deliveries), `GET /api/v1/admin/connections` (list connections with webhook info).
- **Webhook delivery list query** in webhook-repository.
- **Tests**.

## Files

| Agent | Owns |
|---|---|
| implementer | `apps/worker/src/http/routes/admin-webhooks.ts` (new) |
| implementer | `apps/worker/src/http/router.ts` (mount) |
| implementer | `apps/worker/src/modules/outbound-mail/webhook-repository.ts` (add listWebhookDeliveries + listConnections) |
| implementer | `apps/worker/src/modules/outbound-mail/index.ts` (add exports) |
| implementer | `apps/worker/src/http/routes/admin-webhooks.worker.test.ts` (new) |

## Acceptance criteria

- [ ] GET /admin/webhook-events returns delivery records (admin only)
- [ ] GET /admin/connections returns connections with webhook URL + secret
- [ ] Non-admin → 403
- [ ] Unauthenticated → 401
- [ ] Quality gates pass
