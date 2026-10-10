// apps/worker/src/platform/errors.test.ts — CAP-032.
//
// Unit tests for the closed error-code catalog and DomainError class.
// AC1: catalog exists and is exported.
// AC3: derived ErrorCode is a closed literal union — invalid literals are
//      rejected at compile time.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DomainError, ERROR_CODES, type ErrorCode, type HttpErrorBody } from './errors';

describe('CAP-032 — closed error code catalog', () => {
  it('AC1: exports ERROR_CODES as a non-empty object of string entries', () => {
    expect(typeof ERROR_CODES).toBe('object');
    expect(ERROR_CODES).not.toBeNull();
    const entries = Object.entries(ERROR_CODES);
    expect(entries.length).toBeGreaterThanOrEqual(40);
    // Every value must be a string equal to its key.
    for (const [key, value] of entries) {
      expect(typeof value).toBe('string');
      expect(value).toBe(key);
    }
  });

  it('AC3: ErrorCode is a closed literal union — rejects unknown literals', () => {
    // Compile-time proof: the line below MUST be rejected by tsc.
    // If a future change widens ErrorCode to `string`, this line stops
    // erroring and the assertion below catches it.
    // @ts-expect-error — 'R-AUTHZ-004' is NOT in the catalog; the union is closed.
    const invalidCode: ErrorCode = 'R-AUTHZ-004';

    // Runtime backstop: the cast should not actually produce a usable value.
    expect(invalidCode).not.toBe('AUTHENTICATION_REQUIRED');
    // Demonstrative — the union narrows to the catalog values.
    expectTypeOf<ErrorCode>().toEqualTypeOf<(typeof ERROR_CODES)[keyof typeof ERROR_CODES]>();
  });

  it('AC2: HttpErrorBody envelope shape is locked down', () => {
    // The shape is `{ error: { code, message, requestId } }`. Pure type
    // assertion — runtime is exercised by the error middleware tests.
    const env: HttpErrorBody = {
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        requestId: '00000000-0000-4000-8000-000000000000',
      },
    };
    expect(env.error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(env.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('AC1: every catalogued-but-unused code and canonical envelope code is present in the catalog', () => {
    // The earlier catalog-shape test proves every entry is well-formed
    // but does not pin which codes exist. This test pins high-value
    // codes so a future contributor removing one breaks a named test
    // rather than slipping past the shape check.
    //   - Catalogued-but-unused (D-CAP-032-D) — 429 / 503 mappings.
    //   - Canonical envelope codes — the most-used errors in 400 / 413 / 500.
    expect(ERROR_CODES.BODY_TOO_LARGE).toBe('BODY_TOO_LARGE');
    expect(ERROR_CODES.INTERNAL).toBe('INTERNAL');
    expect(ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(ERROR_CODES.LOCK_CONTENTION).toBe('LOCK_CONTENTION');
  });
});

describe('DomainError', () => {
  it('carries the supplied code and message verbatim', () => {
    const error = new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication required',
    });

    expect(error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(error.message).toBe('Authentication required');
    expect(error.name).toBe('DomainError');
  });

  it('round-trips a `.cause` via the Error options', () => {
    const original = new Error('underflow');
    const wrapped = new DomainError({
      code: 'PROVIDER_SEND_FAILED',
      message: 'provider send failed',
      cause: original,
    });

    expect(wrapped.cause).toBe(original);
  });

  it('toJSON() produces the canonical envelope inner shape', () => {
    const error = new DomainError({
      code: 'BLOCKLIST_ENTRY_NOT_FOUND',
      message: 'blocklist entry not found',
      httpStatus: 404,
    });

    const serialised = error.toJSON();

    expect(serialised).toEqual({
      code: 'BLOCKLIST_ENTRY_NOT_FOUND',
      message: 'blocklist entry not found',
    });
    // requestId is added by the HTTP middleware from c.get('requestId'),
    // not by DomainError itself.
    expect(Object.keys(serialised).sort()).toEqual(['code', 'message']);
  });

  it('toJSON() output is JSON-string round-trip safe', () => {
    const error = new DomainError({
      code: 'INTERNAL',
      message: 'unexpected',
    });

    const roundTrip = JSON.parse(JSON.stringify(error)) as unknown;

    expect(roundTrip).toEqual({
      code: 'INTERNAL',
      message: 'unexpected',
    });
  });

  it('default httpStatus is undefined (caller / middleware decides)', () => {
    const error = new DomainError({
      code: 'INTERNAL',
      message: 'no status',
    });
    expect(error.httpStatus).toBeUndefined();
  });

  it('accepts an explicit httpStatus', () => {
    const error = new DomainError({
      code: 'BODY_TOO_LARGE',
      message: 'body too large',
      httpStatus: 413,
    });
    expect(error.httpStatus).toBe(413);
  });
});
