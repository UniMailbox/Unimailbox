# Phase 2 — Reliable Business Loop

## Business goal

The loop is correct under failure. Validation, permission, state machine, idempotency, retry, and audit are enforced.

## User value

No silent corruption, no duplicate sends, no lost deliveries.

## Scope

- **Idempotency**: every mutating endpoint accepts `Idempotency-Key`.
- **Outbox pattern**: `SendMessage` writes `messages` + `outbound_jobs` + `idempotency_records` in one D1 batch.
- **Retry**: queue consumer classifies errors; retryable errors re-queue with backoff; terminal errors mark `failed`.
- **State machine guards**: `applyStatusIfNewer` prevents downgrades; `attempts` cap on outbound jobs.
- **Stale authn**: permission check consults DB on every request, not KV snapshot. KV cache TTL reduced to 60s.
- **Validation**: zod schemas on every endpoint; max body size; max recipient count; max subject length.
- **Error model**: every endpoint returns `{ error: { code, message, requestId } }` with stable codes.
- **Audit log**: full audit event coverage; `/admin/audit-events` UI.
- **Webhook ordering**: `provider_message_state.status_rank` properly applied.
- **Observability**: structured logs, basic request metrics.

## Out of scope

Still no drafts, attachments, sharing.

## Acceptance criteria

```text
[ ] Replaying /messages/send with same Idempotency-Key returns same message id.
[ ] /messages/send with same key + different body returns 409.
[ ] Outbound job survives consumer crash mid-send (attempts++, lock expires, re-queued).
[ ] Webhook arriving before send-complete is queued, not lost.
[ ] No /api/v1/* endpoint accepts a request > 1 MB.
[ ] All audit events are queryable by actor and resource.
[ ] All endpoints return JSON error body with stable code.
```

## Key technical decisions

- Idempotency record TTL: 24 hours.
- Outbound job max attempts: 5.
- Backoff: exponential 2^n seconds.
- KV cache TTL for user perm sets: 60 seconds.

## Migration from legacy

- The new system assumes all user-facing routes on its preview deployment.
- The legacy system continues as fallback on its route.
- Per-deployment cutover begins after Phase 4.

## Risks

- Idempotency key TTL must match client retry window.
- KV cache invalidation on user permission change requires care.
