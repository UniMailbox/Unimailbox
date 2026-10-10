# ADR-004 — Idempotency-Key on All Mutating Endpoints

## Status

Accepted. Amended 2026-08-13 during CAP-027 implementation — see "Amendment (CAP-027)".

## Amendment (CAP-027)

Implementation surfaced three deviations from the letter of the original decision. The
orchestrator accepts them; they are recorded here as the binding interpretation.

1. **`requestHash = sha256(raw request body bytes)`**, not "canonical JSON of body".
   Hashing the exact bytes the client sent is stricter (any byte difference is a conflict)
   and avoids a canonicalization layer with its own bug surface. Consequence: clients must
   send byte-identical bodies on retry — our client does, since TanStack Query retries the
   same serialized request.

2. **Secret-bearing endpoints do not serve stored responses.** `login`, `refresh`,
   `setup/claim`, and `admin/invite-codes` mint credentials that are shown once or revocable
   (`R-AUTH-005`, `R-SECRET-003`). For these four:
   - the record is still written, with `responseJson` **redacted** (secret values replaced by
     a placeholder); the stored body is never served;
   - replay (same key + same hash) **re-executes** the handler and mints fresh credentials —
     pre-CAP-027 retry behaviour;
   - same key + different body still returns `409 IDEMPOTENCY_KEY_REUSED`.
   Serving a stored response could hand back dead (revoked/expired) or dangerously-live
   credentials. Endpoints whose responses carry no secrets keep standard stored-response
   replay.

3. **Persistence is strict batch only where a crash gap would duplicate a business effect.**
   Compose send (R-OUTBOUND-006) and mailbox create write the record in the same D1 batch as
   the business rows. Naturally re-runnable mutations (e.g. mark-read) and low-stakes setup /
   admin writes use best-effort (record written after success); a retry in the gap re-runs a
   safe operation. The smoke-test endpoint uses reserve/settle/release to expose a pending
   state as `409 IDEMPOTENCY_REQUEST_PENDING`.

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