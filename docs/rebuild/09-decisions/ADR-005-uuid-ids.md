# ADR-005 — UUID v4 Identifiers

## Status

Accepted.

## Context

The legacy system uses integer primary keys (`emailId`, `accountId`, `userId`). These appear in URLs, logs, and API responses, leaking database implementation details and making it trivial to enumerate users/messages/mailboxes.

## Decision

All externally visible identifiers are **UUID v4 strings**. Database-generated integer IDs are internal only.

## Consequences

### Positive

- No enumeration attacks via integer IDs.
- Database can be re-sharded without breaking URLs.
- Identifiers are globally unique (safe for client-generated IDs in some flows).

### Negative

- 36-byte vs 4/8-byte storage cost (negligible at our scale).
- Slightly harder to debug (UUIDs vs sequential integers).

### Mitigations

- Indexed queries by UUID are still O(log n) on B-tree.
- For debugging, abbreviated UUID prefixes are logged.

## Alternatives considered

- **ULID**: rejected. Same benefits, less widely understood.
- **Hash IDs**: rejected. Reversible.
- **Integer IDs behind opaque token**: rejected. Adds complexity without removing enumeration if the mapping is exposed.