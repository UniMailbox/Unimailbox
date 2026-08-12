# ADR-003 — Durable Outbox + Queue Consumer

## Status

Accepted.

## Context

The legacy `email-service.send` synchronously calls the provider from the request handler. Failures:

- If the provider accepts but D1 fails: message is lost.
- If the provider times out: client doesn't know if the message was sent.
- If the worker is killed mid-send: status update never happens.

## Decision

We adopt a **durable outbox + queue consumer** pattern:

1. `SendMessage` writes `messages` + `outbound_jobs` + `idempotency_records` in one D1 batch.
2. If external recipients exist, an `OutboundJob` is created and dispatched to Cloudflare Queue.
3. The request handler returns `queued` immediately.
4. A queue consumer claims the job, calls the provider, updates the message status.
5. A scheduled dispatcher recovers jobs that fail or stall.

## Consequences

### Positive

- The request handler is fast (no provider roundtrip in the critical path).
- If the consumer crashes mid-send, the job is recovered (lock TTL + scheduled dispatcher).
- Webhook events and consumer calls converge on the same canonical message status.

### Negative

- More components (outbox + queue + consumer + dispatcher).
- Status changes are not synchronous with the user action.
- Client must poll or rely on TanStack Query invalidation.

### Mitigations

- Idempotency on send prevents duplicates.
- The dispatched state is fast — typically <1s from send to provider-accepted.
- Optimistic UI: client shows "Sent" immediately; webhook updates status when delivered.

## Alternatives considered

- **Synchronous provider call**: rejected. This is what the legacy does and it has the failure modes above.
- **Cloudflare Durable Objects for outbound state**: deferred. May revisit in Phase 6+ if scaling demands.