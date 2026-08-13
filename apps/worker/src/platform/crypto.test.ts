// platform/crypto.test.ts — unit tests for constantTimeCompare and hashPassword.
import { describe, expect, it } from 'vitest';
import { constantTimeCompare, hashPassword } from './crypto';

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

describe('hashPassword', () => {
  it('returns a PasswordHash with correct algorithm and iterations', async () => {
    const result = await hashPassword('test-password');
    expect(result.algorithm).toBe('pbkdf2-sha256');
    expect(result.iterations).toBe(600_000);
  });

  it('generates a salt of exactly 16 bytes', async () => {
    const result = await hashPassword('test-password');
    expect(result.salt).toBeInstanceOf(Uint8Array);
    expect(result.salt.byteLength).toBe(16);
  });

  it('generates a hash of exactly 32 bytes (256 bits)', async () => {
    const result = await hashPassword('test-password');
    expect(result.hash).toBeInstanceOf(Uint8Array);
    expect(result.hash.byteLength).toBe(32);
  });

  it('generates different salts for the same password', async () => {
    const result1 = await hashPassword('test-password');
    const result2 = await hashPassword('test-password');

    // Salts should differ
    expect(result1.salt).not.toEqual(result2.salt);

    // Hashes should also differ because salts differ
    expect(result1.hash).not.toEqual(result2.hash);
  });

  it('generates different hashes for different passwords', async () => {
    const result1 = await hashPassword('password-one');
    const result2 = await hashPassword('password-two');

    expect(result1.hash).not.toEqual(result2.hash);
  });

  it('generates the same hash for the same password and salt', async () => {
    const password = 'test-password';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );

    const hash1 = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
      key,
      256,
    );

    const hash2 = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
      key,
      256,
    );

    // Same inputs → same deterministic output
    expect(new Uint8Array(hash1)).toEqual(new Uint8Array(hash2));
  });

  it('hashes a minimum-length password (8 chars)', async () => {
    const result = await hashPassword('12345678');
    expect(result.hash.byteLength).toBe(32);
  });

  it('hashes a maximum-length password (72 chars)', async () => {
    const result = await hashPassword('a'.repeat(72));
    expect(result.hash.byteLength).toBe(32);
  });

  it('handles passwords with special characters', async () => {
    const result = await hashPassword('P@ssw0rd!#$%^&*()');
    expect(result.hash.byteLength).toBe(32);
    expect(result.salt.byteLength).toBe(16);
  });

  it('handles passwords with Unicode characters', async () => {
    const result = await hashPassword('пароль123');
    expect(result.hash.byteLength).toBe(32);
    expect(result.salt.byteLength).toBe(16);
  });
});
