// platform/idempotency.test.ts — unit tests for the idempotency helper.
//
// These run under vitest's node pool (see vitest.unit.config.ts) — the
// tests that need real D1 bindings live in the worker-pool project
// (see http/routes/*.worker.test.ts).
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_TTL_HOURS,
  actorIdPrefix,
  assertSameRequestHash,
  bearerToken,
  isIdempotencyUniqueViolation,
  opaqueActorId,
  prepareCreateIdempotencyRecord,
  replayResponse,
  sha256Hex,
  sqliteTimestamp,
  type IdempotencyRecord,
} from './idempotency';
import type { Database } from './database';
import { DomainError } from './errors';

// ---------------------------------------------------------------------------
// Statement recorder.
//
// This is NOT a mock of D1 under test — it records the SQL text and bound
// parameters that prepareCreateIdempotencyRecord emits, so the bind order
// (nine placeholders, created_at bound twice) can be asserted precisely.
// D1's own behaviour is covered by the worker-pool tests against real
// bindings, per .claude/rules/testing.md §Mocking.
// ---------------------------------------------------------------------------

interface RecordedStatement {
  sql: string;
  params: unknown[];
}

function statementRecorder(): { db: Database; recorded: RecordedStatement[] } {
  const recorded: RecordedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const entry: RecordedStatement = { sql, params: [] };
      recorded.push(entry);
      return {
        bind(...params: unknown[]) {
          entry.params = params;
          return this;
        },
      };
    },
  } as unknown as Database;
  return { db, recorded };
}

function record(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    actorId: 'actor-1',
    operation: 'POST /api/v1/mailboxes',
    idempotencyKey: 'key-abcdefgh',
    requestHash: 'a'.repeat(64),
    responseStatus: 201,
    responseJson: '{"data":{"id":"mb-1"}}',
    createdAt: '2026-08-13 12:00:00',
    expiresAt: '2026-08-14 12:00:00',
    ...overrides,
  };
}

describe('IDEMPOTENCY_HEADER', () => {
  it('is the canonical "Idempotency-Key" string', () => {
    expect(IDEMPOTENCY_HEADER).toBe('Idempotency-Key');
  });
});

describe('IDEMPOTENCY_TTL_HOURS', () => {
  it('is 24 hours per ADR-004', () => {
    expect(IDEMPOTENCY_TTL_HOURS).toBe(24);
  });
});

describe('IDEMPOTENCY_KEY_PATTERN', () => {
  it('accepts a UUID v4 (36 chars, base alphabet)', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(IDEMPOTENCY_KEY_PATTERN.test(uuid)).toBe(true);
  });

  it('accepts the shortest allowed key (8 chars)', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('abcd1234')).toBe(true);
  });

  it('accepts the longest allowed key (128 chars)', () => {
    const key = 'a'.repeat(128);
    expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(true);
  });

  it('rejects a 7-char key (below the floor)', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('abcd123')).toBe(false);
  });

  it('rejects a 129-char key (above the cap)', () => {
    const key = 'a'.repeat(129);
    expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(false);
  });

  it('rejects a key with a forbidden character (space)', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('abcd 1234')).toBe(false);
  });

  it('rejects a key with a forbidden character (slash)', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('abcd/123')).toBe(false);
  });

  it('rejects an empty key', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('produces 64 lowercase hex characters', async () => {
    const hex = await sha256Hex('hello');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    expect(await sha256Hex('hello')).toBe(await sha256Hex('hello'));
  });

  it('differs for different inputs', async () => {
    expect(await sha256Hex('hello')).not.toBe(await sha256Hex('hellp'));
  });

  it('matches the known SHA-256 vector for "" (empty string)', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is whitespace-sensitive, so a re-serialised body will not replay', async () => {
    // Documented client contract: retries must send a byte-identical body.
    // See migrations/0009_idempotency_records.md §request_hash.
    const a = await sha256Hex('{"a":1,"b":2}');
    const b = await sha256Hex('{ "a": 1, "b": 2 }');
    expect(a).not.toBe(b);
  });

  it('is key-order-sensitive, so a reordered body will not replay', async () => {
    const a = await sha256Hex('{"a":1,"b":2}');
    const b = await sha256Hex('{"b":2,"a":1}');
    expect(a).not.toBe(b);
  });
});

describe('sqliteTimestamp', () => {
  it("formats a Date as SQLite's 'YYYY-MM-DD HH:MM:SS'", () => {
    expect(sqliteTimestamp(new Date('2026-08-13T12:34:56.789Z'))).toBe(
      '2026-08-13 12:34:56',
    );
  });

  it('drops sub-second precision rather than rounding', () => {
    expect(sqliteTimestamp(new Date('2026-08-13T12:34:56.999Z'))).toBe(
      '2026-08-13 12:34:56',
    );
  });

  it('sorts correctly as TEXT against a later timestamp', () => {
    // The whole reason this helper exists: expires_at is compared to
    // datetime('now') as TEXT, so lexical order must match chronological
    // order. An ISO string would break this (see the helper's doc comment).
    const earlier = sqliteTimestamp(new Date('2026-08-14T01:00:00.000Z'));
    const later = sqliteTimestamp(new Date('2026-08-14T12:00:00.000Z'));
    expect(earlier < later).toBe(true);
  });

  it('sorts below a same-day SQLite timestamp that an ISO string would beat', () => {
    // Regression guard. 'T' (0x54) > ' ' (0x20), so an ISO expires_at of
    // 01:00 would compare *greater* than a SQLite now of 12:00 on the same
    // day — an 11-hour-expired record would read as live.
    const expiresAt = sqliteTimestamp(new Date('2026-08-15T01:00:00.000Z'));
    const now = '2026-08-15 12:00:00';
    expect(expiresAt > now).toBe(false);
    expect('2026-08-15T01:00:00.000Z' > now).toBe(true);
  });
});

describe('prepareCreateIdempotencyRecord', () => {
  const params = {
    id: 'rec-1',
    actorId: 'actor-1',
    operation: 'POST /api/v1/mailboxes',
    idempotencyKey: 'key-abcdefgh',
    requestHash: 'b'.repeat(64),
    responseStatus: 201,
    responseJson: '{"data":{"id":"mb-1"}}',
    createdAt: '2026-08-13 12:00:00',
  };

  it('inserts into idempotency_records with all nine columns', () => {
    const { db, recorded } = statementRecorder();
    prepareCreateIdempotencyRecord(db, params);

    expect(recorded).toHaveLength(1);
    const sql = recorded[0]?.sql ?? '';
    expect(sql).toContain('INSERT INTO idempotency_records');
    for (const column of [
      'id',
      'actor_id',
      'operation',
      'idempotency_key',
      'request_hash',
      'response_status',
      'response_json',
      'created_at',
      'expires_at',
    ]) {
      expect(sql).toContain(column);
    }
  });

  it('derives expires_at in SQL as created_at + 24 hours', () => {
    const { db, recorded } = statementRecorder();
    prepareCreateIdempotencyRecord(db, params);

    expect(recorded[0]?.sql).toContain("datetime(?, '+24 hours')");
  });

  it('binds the nine parameters in column order, created_at twice', () => {
    const { db, recorded } = statementRecorder();
    prepareCreateIdempotencyRecord(db, params);

    expect(recorded[0]?.params).toEqual([
      'rec-1',
      'actor-1',
      'POST /api/v1/mailboxes',
      'key-abcdefgh',
      'b'.repeat(64),
      201,
      '{"data":{"id":"mb-1"}}',
      '2026-08-13 12:00:00',
      // Bound again to feed datetime(?, '+24 hours').
      '2026-08-13 12:00:00',
    ]);
  });

  it('binds response_status as a number, not a string', () => {
    const { db, recorded } = statementRecorder();
    prepareCreateIdempotencyRecord(db, params);

    expect(typeof recorded[0]?.params[5]).toBe('number');
  });

  it('never interpolates a value into the SQL text (no string concatenation)', () => {
    const { db, recorded } = statementRecorder();
    prepareCreateIdempotencyRecord(db, {
      ...params,
      // A key that would break out of a naively concatenated statement.
      idempotencyKey: "x'); DROP TABLE idempotency_records;--",
    });

    expect(recorded[0]?.sql).not.toContain('DROP TABLE');
  });
});

describe('assertSameRequestHash', () => {
  it('passes when the hashes match', () => {
    expect(() =>
      assertSameRequestHash(record({ requestHash: 'c'.repeat(64) }), 'c'.repeat(64)),
    ).not.toThrow();
  });

  it('throws 409 IDEMPOTENCY_KEY_REUSED when the hashes differ', () => {
    try {
      assertSameRequestHash(record({ requestHash: 'c'.repeat(64) }), 'd'.repeat(64));
      expect.unreachable('expected a DomainError');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((error as DomainError).httpStatus).toBe(409);
    }
  });

  it('does not leak either request body or hash in the error message', () => {
    try {
      assertSameRequestHash(record({ requestHash: 'c'.repeat(64) }), 'd'.repeat(64));
      expect.unreachable('expected a DomainError');
    } catch (error) {
      const message = (error as DomainError).message;
      expect(message).not.toContain('c'.repeat(64));
      expect(message).not.toContain('d'.repeat(64));
    }
  });
});

describe('replayResponse', () => {
  it('reproduces the stored status and body byte for byte', async () => {
    const stored = record({ responseStatus: 202, responseJson: '{"data":{"n":1}}' });
    const response = replayResponse(stored);

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"data":{"n":1}}');
  });

  it('sets a JSON content type', () => {
    expect(replayResponse(record()).headers.get('Content-Type')).toBe(
      'application/json',
    );
  });
});

describe('isIdempotencyUniqueViolation', () => {
  it('recognises the D1 unique-constraint failure on idempotency_records', () => {
    const error = new Error(
      'D1_ERROR: UNIQUE constraint failed: idempotency_records.actor_id, idempotency_records.operation, idempotency_records.idempotency_key',
    );
    expect(isIdempotencyUniqueViolation(error)).toBe(true);
  });

  it('ignores a unique violation on a different table', () => {
    // A mailbox address collision must keep surfacing as
    // DOMAIN_ADDRESS_TAKEN, not be mistaken for a replay.
    const error = new Error(
      'D1_ERROR: UNIQUE constraint failed: mailboxes.domain_id, mailboxes.local_part',
    );
    expect(isIdempotencyUniqueViolation(error)).toBe(false);
  });

  it('ignores an unrelated error', () => {
    expect(isIdempotencyUniqueViolation(new Error('network down'))).toBe(false);
  });

  it('ignores a non-Error value', () => {
    expect(isIdempotencyUniqueViolation('UNIQUE constraint failed')).toBe(false);
    expect(isIdempotencyUniqueViolation(null)).toBe(false);
    expect(isIdempotencyUniqueViolation(undefined)).toBe(false);
  });
});

describe('opaqueActorId', () => {
  it('produces a 64-char hex digest', async () => {
    expect(await opaqueActorId('email', 'user@example.com')).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('is deterministic for the same kind and value', async () => {
    expect(await opaqueActorId('email', 'a@example.com')).toBe(
      await opaqueActorId('email', 'a@example.com'),
    );
  });

  it('separates domains: the same value under two kinds differs', async () => {
    expect(await opaqueActorId('email', 'secret')).not.toBe(
      await opaqueActorId('refresh-token', 'secret'),
    );
  });

  it('never equals the bare sha256 of the value (R-SECRET-003)', async () => {
    // sessions.refresh_token_hash is a bare sha256(token). The prefix keeps
    // an actor_id from doubling as a session lookup key.
    const token = 'refresh-token-value';
    expect(await opaqueActorId('refresh-token', token)).not.toBe(
      await sha256Hex(token),
    );
  });

  it('does not contain the raw value', async () => {
    const actorId = await opaqueActorId('setup-session', 'super-secret-token');
    expect(actorId).not.toContain('super-secret-token');
  });
});

describe('bearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
  });

  it('returns empty string when the scheme is missing', () => {
    expect(bearerToken('abc123')).toBe('');
  });

  it('returns empty string when the header is absent', () => {
    expect(bearerToken(undefined)).toBe('');
  });

  it('is case-sensitive on the scheme (matches setupSession middleware)', () => {
    expect(bearerToken('bearer abc123')).toBe('');
  });
});

describe('actorIdPrefix', () => {
  it('returns the first 8 characters only', () => {
    expect(actorIdPrefix('0123456789abcdef'.repeat(4))).toBe('01234567');
  });

  it('is short enough that the full actor_id cannot be recovered from a log', () => {
    const actorId = 'f'.repeat(64);
    expect(actorIdPrefix(actorId).length).toBe(8);
    expect(actorIdPrefix(actorId).length).toBeLessThan(actorId.length);
  });
});
