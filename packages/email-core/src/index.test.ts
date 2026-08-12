// packages/email-core — unit test for the trivial pure helper.
// The full RFC 5322 parser lands with the inbound-mail module (CAP-021).
import { describe, expect, it } from 'vitest';
import { normalizeAddress } from './index';

describe('normalizeAddress', () => {
  it('lowercases and trims the input', () => {
    expect(normalizeAddress('  User@Example.COM ')).toBe('user@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeAddress('Foo@Bar.Test');
    expect(normalizeAddress(once)).toBe(once);
  });

  it('returns an empty string for an empty input', () => {
    expect(normalizeAddress('')).toBe('');
  });
});