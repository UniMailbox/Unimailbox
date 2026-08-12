// Demonstrative unit test — apps/worker/src/platform/errors.test.ts.
// Proves DomainError carries a stable `code`, round-trips `.cause`, and
// serialises via `.toJSON()` to the canonical envelope inner shape
// `{ code, message }`. See http/errors.ts for the outer `{ error: ... }`
// wrapping the HTTP middleware produces.
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';

describe('DomainError', () => {
  it('carries the supplied code and message verbatim', () => {
    const error = new DomainError({
      code: 'R-AUTHZ-004',
      message: 'permission denied',
    });

    expect(error.code).toBe('R-AUTHZ-004');
    expect(error.message).toBe('permission denied');
    expect(error.name).toBe('DomainError');
  });

  it('round-trips a `.cause` via the Error options', () => {
    const original = new Error('underflow');
    const wrapped = new DomainError({
      code: 'R-DATA-005',
      message: 'json-in-text column forbidden',
      cause: original,
    });

    expect(wrapped.cause).toBe(original);
  });

  it('toJSON() produces the canonical envelope inner shape', () => {
    const error = new DomainError({
      code: 'R-INBOUND-008',
      message: 'inbound batch atomic write failed',
      httpStatus: 503,
    });

    const serialised = error.toJSON();

    expect(serialised).toEqual({
      code: 'R-INBOUND-008',
      message: 'inbound batch atomic write failed',
    });
    // requestId is added by the HTTP middleware from c.get('requestId'),
    // not by DomainError itself.
    expect(Object.keys(serialised).sort()).toEqual(['code', 'message']);
  });

  it('toJSON() output is JSON-string round-trip safe', () => {
    const error = new DomainError({
      code: 'R-SECRET-003',
      message: 'decrypted credentials never leave request scope',
    });

    const roundTrip = JSON.parse(JSON.stringify(error)) as unknown;

    expect(roundTrip).toEqual({
      code: 'R-SECRET-003',
      message: 'decrypted credentials never leave request scope',
    });
  });
});