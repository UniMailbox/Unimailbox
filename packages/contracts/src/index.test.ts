// packages/contracts — unit test for the sample zod schemas.
// Proves the harness can round-trip a schema, surface a safeParse failure,
// and that the failed parse shape is stable for callers.
import { describe, expect, it } from 'vitest';
import { emailAddressSchema, uuidSchema } from './index';

describe('emailAddressSchema', () => {
  it('accepts a plain address', () => {
    const result = emailAddressSchema.parse('user@example.com');
    expect(result).toBe('user@example.com');
  });

  it('normalises to lowercase + trimmed form (R-DATA-001)', () => {
    const result = emailAddressSchema.parse('  USER@Example.COM ');
    expect(result).toBe('user@example.com');
  });

  it('rejects malformed addresses via safeParse', () => {
    const result = emailAddressSchema.safeParse('not-an-email');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      // stable shape: every issue carries a path + a code
      for (const issue of result.error.issues) {
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.code).toBe('string');
      }
    }
  });

  it('rejects addresses longer than 254 chars', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(200)}.com`;
    const result = emailAddressSchema.safeParse(long);
    expect(result.success).toBe(false);
  });
});

describe('uuidSchema', () => {
  it('accepts a uuid-shaped string', () => {
    const result = uuidSchema.parse('00000000-0000-4000-8000-000000000001');
    expect(result).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('rejects a non-uuid string', () => {
    const result = uuidSchema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });
});