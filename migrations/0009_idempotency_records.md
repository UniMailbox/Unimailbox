# 0009_idempotency_records — CAP-027 ADR-004

## Purpose

Adds the `idempotency_records` table that lets every mutating endpoint
(`POST`, `PATCH`, `DELETE`) reject duplicate requests by `Idempotency-Key`
header. A client retrying a successful send with the same key + same body
gets the stored response back; a retry with a different body is rejected
with `409 IDEMPOTENCY_KEY_REUSED`.

Owns the table: the `idempotency` platform helper
(`apps/worker/src/platform/idempotency.ts`) reads from and writes to it
from inside route handlers. The table itself is owned by the `platform/`
zone (per `.claude/rules/architecture.md` §Persistence ownership — the
closest match is `admin` for audit-shaped operational data; the helper
sits in `platform/` because every layer needs it).

## Compatibility window

- **Backward-compatible (additive)** — new table, no ALTER. An existing
  deployment at `0008` applies cleanly.
- **Forward-incompatible** — future migrations must not rename the
  `(actor_id, operation, idempotency_key)` columns or their uniqueness,
  because the route handlers depend on the column names. The CHECK on
  `request_hash` (`length = 64`) pins the contract: the hash is always
  a SHA-256 hex digest.

## Expected duration

Single-digit milliseconds on a fresh D1 simulator. Production D1 apply
time is dominated by the round-trip.

## Data-backfill strategy

None. The table starts empty; entries are written by the idempotency
middleware as traffic flows.

## Migration tracking convention (F1)

The migration creates `d1_migrations` (already exists from 0001 — kept
here for explicitness) and inserts its own row in the same D1 batch.
See `0001_initial.md` §Migration tracking convention (F1).

## Conventions

### `actor_id` is opaque

`actor_id` is intentionally **not** a foreign key to `users(id)`. It
may be one of:

| Source | Origin |
|---|---|
| authenticated user | `userId` from `c.get('userId')` |
| setup endpoint | `sha256_hex(SETUP_SESSION token)` |
| register endpoint | `sha256_hex(code)` |
| login / refresh | `sha256_hex(email)` |

Storing opaque actor_ids lets the same table serve all endpoint
categories without polymorphic-key complexity. The unique index on
`(actor_id, operation, idempotency_key)` keeps two different actors
isolated: actor A retrying their own request does not collide with
actor B using the same key by coincidence.

### `request_hash` is SHA-256 of the raw body

Hex-encoded, 64 characters (the migration's `CHECK (length = 64)` pins
this). Clients must retry with a **byte-identical** body — JSON
whitespace or key ordering changes the hash and is rejected as a
different request. Documented here so future client implementers know
the constraint; the server does not auto-canonicalize.

### `operation` is the path *template*

Hard-coded per route, e.g. `POST /api/v1/mailboxes/:mailboxId/messages/send`.
Never the resolved runtime path — that would let two different
mailboxes collide on the same key.

### TTL = 24h

`expires_at = created_at + 24 hours` (sqlite datetime arithmetic in the
helper, not in SQL). The `expires_at` index supports a future daily
cron purge (out of scope for CAP-027).

## Verification queries

The companion `0009_idempotency_records.verify.sql` runs these checks
automatically. Manual sanity queries:

```sql
-- table exists with the 8 expected columns
SELECT name FROM pragma_table_info('idempotency_records') ORDER BY name;

-- UNIQUE index on (actor_id, operation, idempotency_key) — the dedup backbone
SELECT sql FROM sqlite_master WHERE type='index' AND name='idempotency_records_unique';

-- expires_at index — future purge target
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='idempotency_records';

-- migration tracking row
SELECT * FROM d1_migrations WHERE name = '0009_idempotency_records.sql';
```

## Recovery procedure

The same Time Travel / local-state-delete procedure documented in
`0001_initial.md` §Recovery procedure applies. This migration is
additive so a partial-apply failure (which D1 should not produce — the
DDL is `IF NOT EXISTS`) is recoverable by restoring from the Time Travel
bookmark and re-running.

## Companion files

- `0009_idempotency_records.sql` — the schema.
- `0009_idempotency_records.verify.sql` — assertions run by the migration runner.
- `apps/worker/src/platform/idempotency.ts` — the helper that reads/writes
  this table from route handlers.
- `apps/worker/src/http/middleware/idempotency.ts` — the middleware that
  enforces `Idempotency-Key` header presence and format on every mutating
  route.

## Deferred schema decisions

- **TTL purge cron** — not in this capability. The `expires_at` index is
  present so the future cron (a separate capability) has a fast target.
- **actor_id column family** — we store one opaque column rather than a
  `(actor_kind, actor_id)` pair. If a future capability needs to filter
  by actor type (e.g. "all setup endpoints in the last hour"), add a
  derived column or a follow-up migration. The current shape is the
  minimum that satisfies ADR-004.