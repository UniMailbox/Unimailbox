# ADR-004 — Idempotency-Key on All Mutating Endpoints

## Status

Accepted.

## Context

The legacy system has no replay safety. A client retrying a send call may double-deliver. A client retrying a mailbox creation may fail unpredictably.

## Decision

We require `Idempotency-Key` header on all mutating endpoints (`POST`, `PATCH`, `DELETE`). The handler:

1. Computes `requestHash = sha256(canonical JSON of request body)`.
2. Inserts into `idempotency_records` with `(actorUserId, operation, idempotencyKey, requestHash, responseStatus, responseJson)` in the same D1 batch as the business write.
3. On replay (same key, same hash): returns the stored response.
4. On conflict (same key, different hash): returns `409 IDEMPOTENCY_KEY_REUSED`.

## Consequences

### Positive

- Client retries are guaranteed safe.
- Network-level retries do not duplicate business effects.
- Idempotency record serves as an audit trail of mutations.

### Negative

- Client must generate a key (UUID) per request.
- 24-hour TTL means stale keys are not deduplicated after expiry.

### Mitigations

- Client (TanStack Query) auto-generates `Idempotency-Key` per mutation.
- A 24-hour TTL matches typical client retry windows.
- Daily cron purges expired records.

## Alternatives considered

- **Server-generated idempotency**: rejected. Requires a separate round-trip.
- **Content-hash only (no key)**: rejected. Different requests may have identical bodies; client cannot prevent duplicates.
- **Optimistic concurrency only**: rejected. Doesn't cover network-level retries.