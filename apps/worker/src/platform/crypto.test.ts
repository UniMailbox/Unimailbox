// platform/crypto.test.ts — unit tests for constantTimeCompare.
import { describe, expect, it } from 'vitest';
import { constantTimeCompare } from './crypto';

describe('constantTimeCompare', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeCompare('abc', 'abc')).toBe(true);
  });

  it('returns false for unequal strings of same length', () => {
    expect(constantTimeCompare('abc', 'abd')).toBe(false);
  });

  it('returns false for unequal strings of different length', () => {
    expect(constantTimeCompare('abc', 'abcd')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(constantTimeCompare('', '')).toBe(true);
  });

  it('returns false when one string is empty', () => {
    expect(constantTimeCompare('abc', '')).toBe(false);
    expect(constantTimeCompare('', 'abc')).toBe(false);
  });

  it('compares strings with special characters', () => {
    expect(constantTimeCompare('test-token-123', 'test-token-123')).toBe(true);
    expect(constantTimeCompare('test-token-123', 'test-token-124')).toBe(false);
  });

  it('compares UUID-like strings', () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    expect(constantTimeCompare(uuid, uuid)).toBe(true);
    expect(constantTimeCompare(uuid, '00000000-0000-4000-8000-000000000002')).toBe(false);
  });
});
