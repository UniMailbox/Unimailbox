// platform/idempotency — CAP-027 / ADR-004.
//
// Helpers that let every mutating endpoint record + replay idempotent
// requests. The middleware (http/middleware/idempotency.ts) enforces
// the Idempotency-Key header presence + format; the helpers in this
// file do the read/write/replay work.
//
// Three modes of use:
//   1. Best-effort (setup + auth): handler calls tryReplayIdempotency()
//      before the use case, then writes the record as a separate D1
//      statement on success.
//   2. Strict batch (compose, mailboxes, messages): handler appends
//      prepareCreateIdempotencyRecord() to the route's existing D1
//      batch — the row lands atomically with the business writes
//      (R-OUTBOUND-006).
//   3. Atomic lookup+insert+update (outbound-smoke-test only, option C):
//      handler inserts a "pending" record before Brevo sends, then
//      updates response_status / response_json on return.

import type { Database } from './database';
import { DomainError } from './errors';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** HTTP header carrying the per-request idempotency key. ADR-004 §Decision. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** TTL for stored records (ADR-004 §Mitigations). */
export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Allowed format for the `Idempotency-Key` header.
 *
 * 8-128 chars from the URL-safe alphabet. Long enough to be a UUID v4
 * (36 chars) plus headroom; short enough to bound row + index size.
 *
 * The 8-char minimum blocks single-letter / sequential keys that an
 * attacker could brute-force to collide with another actor's pending
 * request.
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  readonly actorId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseJson: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateIdempotencyRecordParams {
  readonly id: string;
  readonly actorId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseJson: string;
  /**
   * SQLite datetime string ('YYYY-MM-DD HH:MM:SS' UTC). Produce it with
   * {@link sqliteTimestamp} — never `Date#toISOString()`. `expires_at` is
   * derived from this value in SQL, and both are compared as TEXT against
   * `datetime('now')`, so all three must share one format.
   */
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// sqliteTimestamp — the one timestamp format this table speaks.
// ---------------------------------------------------------------------------

/**
 * Format a Date as a SQLite datetime string: 'YYYY-MM-DD HH:MM:SS' UTC.
 *
 * This matches `datetime('now')` and the migration's
 * `DEFAULT (datetime('now'))`. It exists because mixing formats here is a
 * silent correctness bug, not a cosmetic one: SQLite compares datetimes as
 * TEXT, and an ISO 8601 string sorts *above* a SQLite one for the same
 * instant (the 'T' separator, 0x54, beats the space, 0x20). An ISO
 * `expires_at` would therefore satisfy `expires_at > datetime('now')` for
 * the entire calendar day on which it expired, resurrecting records that
 * are hours past their TTL.
 */
export function sqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// sha256Hex — canonical hex digest used for both request body hashing
// (idempotency replay detection) and opaque actor_id computation
// (setup session token, registration code, login email).
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of `input` (UTF-8). Always 64 lowercase hex chars.
 *
 * Defined in `platform/` rather than `platform/crypto.ts` because the
 * constant-time comparison and PBKDF2 helpers there are password-shaped;
 * this is request-shaped.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// findIdempotencyRecord — read-side helper.
// ---------------------------------------------------------------------------

/**
 * Look up a stored record by (actor, op, key). Returns null if the row
 * does not exist OR has expired.
 *
 * Expiry is enforced at read time so a future purge cron can simply
 * delete rows without the handler's knowledge. Reads after expiry
 * always miss — the client should send a fresh key.
 */
export async function findIdempotencyRecord(
  db: Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
): Promise<IdempotencyRecord | null> {
  const row = await db
    .prepare(
      `SELECT actor_id, operation, idempotency_key, request_hash,
              response_status, response_json, created_at, expires_at
       FROM idempotency_records
       WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
         AND expires_at > datetime('now')
       LIMIT 1`,
    )
    .bind(actorId, operation, idempotencyKey)
    .first<{
      actor_id: string;
      operation: string;
      idempotency_key: string;
      request_hash: string;
      response_status: number;
      response_json: string;
      created_at: string;
      expires_at: string;
    }>();

  if (!row) return null;

  return {
    actorId: row.actor_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseJson: row.response_json,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// prepareCreateIdempotencyRecord — write-side helper.
// ---------------------------------------------------------------------------

/**
 * Build a prepared INSERT for an idempotency record. The handler appends
 * this to its `db.batch([...])` (strict mode) or runs it as a separate
 * statement (best-effort mode).
 *
 * `expires_at` is computed in SQL as `datetime(createdAt, '+24 hours')`
 * rather than in JS, so the stored value is guaranteed to share a format
 * with `created_at` and with the `datetime('now')` that
 * {@link findIdempotencyRecord} compares it against. See
 * {@link sqliteTimestamp} for why that matters.
 */
export function prepareCreateIdempotencyRecord(
  db: Database,
  params: CreateIdempotencyRecordParams,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO idempotency_records
         (id, actor_id, operation, idempotency_key, request_hash,
          response_status, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(?, '+${IDEMPOTENCY_TTL_HOURS} hours'))`,
    )
    .bind(
      params.id,
      params.actorId,
      params.operation,
      params.idempotencyKey,
      params.requestHash,
      params.responseStatus,
      params.responseJson,
      params.createdAt,
      // Bound a second time: the TTL is derived from created_at in SQL.
      params.createdAt,
    );
}

// ---------------------------------------------------------------------------
// Concurrency — the UNIQUE index is the lock.
// ---------------------------------------------------------------------------

/**
 * True if `error` is the D1 UNIQUE-constraint failure raised when two
 * concurrent requests carrying the same key race to INSERT.
 *
 * The check is scoped to `idempotency_records` on purpose: a route's batch
 * can also violate a *business* UNIQUE constraint (mailboxes.local_part,
 * for instance) and that must keep propagating as its own domain error
 * rather than being mistaken for a replay.
 */
export function isIdempotencyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes('UNIQUE constraint failed') &&
    error.message.includes('idempotency_records')
  );
}

/**
 * Build the replay Response for a stored record: the status and body the
 * first request returned, byte for byte.
 */
export function replayResponse(record: IdempotencyRecord): Response {
  return new Response(record.responseJson, {
    status: record.responseStatus,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve the loser of an INSERT race: re-read the winner's row and replay
 * it. Called from a `catch` after {@link isIdempotencyUniqueViolation}.
 *
 * Throws 409 IDEMPOTENCY_KEY_REUSED if the winning row turns out to carry a
 * different request hash — two genuinely different bodies raced under one
 * key, which is a client bug, not a retry.
 */
export async function replayAfterRace(
  db: Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<Response> {
  const winner = await findIdempotencyRecord(db, actorId, operation, idempotencyKey);

  if (!winner) {
    // The row collided a moment ago but is gone now (TTL purge, or a
    // rolled-back sibling statement). Surface it rather than inventing a
    // response the client never received.
    throw new DomainError({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Concurrent request with the same Idempotency-Key is in flight',
      httpStatus: 409,
    });
  }

  assertSameRequestHash(winner, requestHash);
  return replayResponse(winner);
}

// ---------------------------------------------------------------------------
// Best-effort mode (option B) — setup, auth, admin.
// ---------------------------------------------------------------------------

/**
 * Write the record after the use case has already succeeded.
 *
 * This is the option-B trade-off recorded in the CAP-027 contract: the use
 * cases behind these endpoints own their own D1 batch and do not expose it,
 * so the record cannot ride along atomically. A crash in the gap between the
 * business commit and this write means the retry re-runs the use case; every
 * endpoint on this path has a natural guard (singularity, UNIQUE, or
 * single-use code) that makes the re-run safe.
 *
 * A lost INSERT race is swallowed deliberately: the winner already stored a
 * response for this key, so there is nothing to add and nothing to fail over.
 */
export async function writeIdempotencyRecord(
  db: Database,
  params: CreateIdempotencyRecordParams,
): Promise<void> {
  try {
    await prepareCreateIdempotencyRecord(db, params).run();
  } catch (error) {
    if (isIdempotencyUniqueViolation(error)) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Opaque actor identity.
// ---------------------------------------------------------------------------

/**
 * Derive the opaque `actor_id` for an endpoint that runs before (or without)
 * an authenticated user.
 *
 * Every input is domain-separated by a `kind` prefix so the resulting digest
 * can never be byte-identical to a credential lookup key stored elsewhere.
 * That matters concretely for refresh tokens: `sessions.refresh_token_hash`
 * is a bare `sha256(token)`, so an unprefixed actor_id would put a valid
 * session-lookup key into a second table (R-SECRET-003 — a secret's *hash*
 * is still a lookup capability when some other table is indexed by it).
 *
 * The raw secret never reaches D1; only this digest does.
 */
export async function opaqueActorId(
  kind: 'setup-session' | 'registration-code' | 'email' | 'refresh-token',
  value: string,
): Promise<string> {
  return sha256Hex(`${kind}:${value}`);
}

/**
 * Extract the bearer token from an Authorization header, for setup routes
 * that key idempotency off the setup session.
 *
 * The `setupSession` middleware has already rejected a missing or malformed
 * header with 401 by the time a handler calls this, so the empty-string
 * fallback is unreachable in practice — it exists so the helper is total.
 */
export function bearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith('Bearer ')) return '';
  return authorizationHeader.slice('Bearer '.length);
}

/**
 * First 8 hex characters of an actor_id — the only form safe to log.
 *
 * `.claude/rules/security.md` §Logging: never log the actor_id itself, and
 * never log the Idempotency-Key value at all.
 */
export function actorIdPrefix(actorId: string): string {
  return actorId.slice(0, 8);
}

/**
 * The `response_status` a reserved-but-unsettled record carries.
 *
 * `/setup/outbound-smoke-test` sends a real email through Brevo, so a
 * re-run is not free the way the other setup endpoints are. It reserves the
 * key *before* the provider call and settles it after, which means a crash
 * mid-send leaves a reservation behind and the retry is refused rather than
 * silently sending a second email. 202 is the honest status for "accepted,
 * outcome not yet known" and satisfies the table's 100..599 CHECK.
 */
export const IDEMPOTENCY_PENDING_STATUS = 202;

/** Body stored against a reservation until the real response settles it. */
export const IDEMPOTENCY_PENDING_BODY = '{"pending":true}';

/** True if `record` is a reservation that never settled. */
export function isPendingRecord(record: IdempotencyRecord): boolean {
  return record.responseJson === IDEMPOTENCY_PENDING_BODY;
}

/**
 * Build the UPDATE that settles a reservation with the real response.
 * Scoped by (actor, operation, key) — the same tuple the unique index
 * covers — so it can never settle another actor's reservation.
 */
export function prepareSettleIdempotencyRecord(
  db: Database,
  params: {
    readonly actorId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
    readonly responseStatus: number;
    readonly responseJson: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE idempotency_records
          SET response_status = ?, response_json = ?
        WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
    )
    .bind(
      params.responseStatus,
      params.responseJson,
      params.actorId,
      params.operation,
      params.idempotencyKey,
    );
}

/**
 * Drop a reservation whose operation failed, so the operator can retry.
 *
 * Without this a transient Brevo error would wedge the smoke test until the
 * 24h TTL expired.
 */
export function prepareReleaseIdempotencyRecord(
  db: Database,
  params: {
    readonly actorId: string;
    readonly operation: string;
    readonly idempotencyKey: string;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM idempotency_records
        WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
    )
    .bind(params.actorId, params.operation, params.idempotencyKey);
}

// ---------------------------------------------------------------------------
// tryReplayIdempotency — convenience wrapper used by the best-effort routes.
// ---------------------------------------------------------------------------

/**
 * Guard: a stored record must have been produced by the same request body.
 *
 * Same key + different hash is the ADR-004 conflict case — the client
 * reused a key it had already spent on a different request.
 */
export function assertSameRequestHash(record: IdempotencyRecord, requestHash: string): void {
  if (record.requestHash !== requestHash) {
    throw new DomainError({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'Idempotency-Key reused with a different request body',
      httpStatus: 409,
    });
  }
}

/**
 * If a matching record exists, returns a Response that replays it.
 * If no record exists, returns null and the handler proceeds.
 * If the record exists with a different request hash, throws 409
 * IDEMPOTENCY_KEY_REUSED.
 *
 * Used by setup + auth routes (best-effort mode). The strict-mode routes
 * call findIdempotencyRecord() directly so they can decide whether to
 * fold the replay into the same D1 batch as the business write.
 */
export async function tryReplayIdempotency(
  db: Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<Response | null> {
  const record = await findIdempotencyRecord(db, actorId, operation, idempotencyKey);

  if (!record) return null;

  assertSameRequestHash(record, requestHash);
  return replayResponse(record);
}
