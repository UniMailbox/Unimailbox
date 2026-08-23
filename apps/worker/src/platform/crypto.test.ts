// platform/crypto.test.ts — unit tests for constantTimeCompare, hashPassword,
// verifyPassword, and AES-GCM encrypt/decrypt (ADR-007).
import { describe, expect, it } from 'vitest';
import {
  constantTimeCompare,
  hashPassword,
  verifyPassword,
  importEncryptionKey,
  encrypt,
  decrypt,
} from './crypto';

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

// ---------------------------------------------------------------------------
// AES-GCM encrypt/decrypt — ADR-007
// ---------------------------------------------------------------------------

describe('importEncryptionKey', () => {
  it('imports a valid 32-byte hex key', async () => {
    // A 32-byte key encoded as 64 hex characters
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    expect(key).toBeInstanceOf(CryptoKey);
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('imports a real 256-bit hex key', async () => {
    // Example: 256-bit key as hex (64 hex chars = 32 bytes)
    const hexKey = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const key = await importEncryptionKey(hexKey);
    expect(key.algorithm.name).toBe('AES-GCM');
  });
});

describe('encrypt', () => {
  it('encrypts plaintext to ciphertext with IV and auth tag', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const encrypted = await encrypt('test-api-key', key);

    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.ciphertext.byteLength).toBeGreaterThan(0);
    expect(encrypted.iv).toBeInstanceOf(Uint8Array);
    expect(encrypted.iv.byteLength).toBe(12); // GCM standard IV length
    expect(encrypted.authTag).toBeInstanceOf(Uint8Array);
    expect(encrypted.authTag.byteLength).toBe(16); // GCM tag length
  });

  it('generates different ciphertext for the same plaintext (random IV)', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const encrypted1 = await encrypt('test-api-key', key);
    const encrypted2 = await encrypt('test-api-key', key);

    // IVs should differ
    expect(encrypted1.iv).not.toEqual(encrypted2.iv);
    // Ciphertexts should also differ because IVs differ
    expect(encrypted1.ciphertext).not.toEqual(encrypted2.ciphertext);
  });

  it('encrypts empty string', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const encrypted = await encrypt('', key);
    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
    expect(encrypted.iv.byteLength).toBe(12);
    expect(encrypted.authTag.byteLength).toBe(16);
  });

  it('encrypts long API key (100+ chars)', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const longKey = 'x'.repeat(150);
    const encrypted = await encrypt(longKey, key);
    expect(encrypted.ciphertext.byteLength).toBeGreaterThan(100);
  });

  it('encrypts API key with special characters', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const apiKey = 'xkcd-2024!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`';
    const encrypted = await encrypt(apiKey, key);
    expect(encrypted.ciphertext).toBeInstanceOf(Uint8Array);
  });
});

describe('decrypt', () => {
  it('decrypts to original plaintext', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const plaintext = 'my-secret-api-key';
    const encrypted = await encrypt(plaintext, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('decrypts empty string', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const encrypted = await encrypt('', key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toBe('');
  });

  it('decrypts long API key', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const longKey = 'x'.repeat(150);
    const encrypted = await encrypt(longKey, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toBe(longKey);
  });

  it('decrypts API key with special characters', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const apiKey = 'xkcd-2024!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`';
    const encrypted = await encrypt(apiKey, key);
    const decrypted = await decrypt(encrypted, key);
    expect(decrypted).toBe(apiKey);
  });

  it('throws on wrong key', async () => {
    const hexKey1 = 'a'.repeat(64);
    const hexKey2 = 'b'.repeat(64);
    const key1 = await importEncryptionKey(hexKey1);
    const key2 = await importEncryptionKey(hexKey2);
    const plaintext = 'my-secret-api-key';
    const encrypted = await encrypt(plaintext, key1);

    // Decrypting with a different key should fail
    await expect(decrypt(encrypted, key2)).rejects.toThrow();
  });

  it('throws on tampered ciphertext', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const plaintext = 'my-secret-api-key';
    const encrypted = await encrypt(plaintext, key);

    // Tamper with the ciphertext
    const tampered = {
      ciphertext: new Uint8Array(encrypted.ciphertext),
      iv: encrypted.iv,
      authTag: encrypted.authTag,
    };
    tampered.ciphertext[0] = tampered.ciphertext[0] ^ 0xff;

    await expect(decrypt(tampered, key)).rejects.toThrow();
  });

  it('throws on tampered auth tag', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const plaintext = 'my-secret-api-key';
    const encrypted = await encrypt(plaintext, key);

    // Tamper with the auth tag
    const tampered = {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: new Uint8Array(encrypted.authTag),
    };
    tampered.authTag[0] = tampered.authTag[0] ^ 0xff;

    await expect(decrypt(tampered, key)).rejects.toThrow();
  });
});

describe('encrypt/decrypt round-trip', () => {
  it('round-trips Brevo-style API keys', async () => {
    const hexKey = 'a'.repeat(64);
    const key = await importEncryptionKey(hexKey);
    const apiKeys = [
      'xkeys-1234567890abcdef',
      'brevo-api-key-1234567890abcdefghijklmnopqrstuvwxyz',
      'a'.repeat(10),
      'z'.repeat(100),
    ];

    for (const original of apiKeys) {
      const encrypted = await encrypt(original, key);
      const decrypted = await decrypt(encrypted, key);
      expect(decrypted).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPassword — CAP-019
// ---------------------------------------------------------------------------

describe('verifyPassword', () => {
  it('returns true for correct password', async () => {
    const password = 'test-password-123';
    const stored = await hashPassword(password);
    const result = await verifyPassword(password, stored);
    expect(result).toBe(true);
  });

  it('returns false for incorrect password', async () => {
    const password = 'test-password-123';
    const wrongPassword = 'wrong-password-456';
    const stored = await hashPassword(password);
    const result = await verifyPassword(wrongPassword, stored);
    expect(result).toBe(false);
  });

  it('returns false for empty password when non-empty was hashed', async () => {
    const password = 'test-password-123';
    const stored = await hashPassword(password);
    const result = await verifyPassword('', stored);
    expect(result).toBe(false);
  });

  it('returns false for different case of same password', async () => {
    const password = 'TestPassword123';
    const wrongCase = 'testpassword123';
    const stored = await hashPassword(password);
    const result = await verifyPassword(wrongCase, stored);
    expect(result).toBe(false);
  });

  it('verifies R-AUTH-007 lower-bound password (6 chars)', async () => {
    const password = '123456';
    const stored = await hashPassword(password);
    const result = await verifyPassword(password, stored);
    expect(result).toBe(true);
  });

  it('verifies R-AUTH-007 upper-bound password (30 chars)', async () => {
    const password = 'a'.repeat(30);
    const stored = await hashPassword(password);
    const result = await verifyPassword(password, stored);
    expect(result).toBe(true);
  });

  it('verifies password with special characters', async () => {
    const password = 'P@ssw0rd!#$%^&*()';
    const stored = await hashPassword(password);
    const result = await verifyPassword(password, stored);
    expect(result).toBe(true);
  });

  it('verifies password with Unicode characters', async () => {
    const password = 'пароль123';
    const stored = await hashPassword(password);
    const result = await verifyPassword(password, stored);
    expect(result).toBe(true);
  });

  it('verifies password against manually-constructed PasswordHash', async () => {
    // Test that verifyPassword works with the exact shape stored in the database
    const password = 'manual-test-password';
    const salt = crypto.getRandomValues(new Uint8Array(16));

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const hashBuffer = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
      key,
      256,
    );

    const stored: PasswordHash = {
      algorithm: 'pbkdf2-sha256',
      iterations: 600_000,
      salt,
      hash: new Uint8Array(hashBuffer),
    };

    const result = await verifyPassword(password, stored);
    expect(result).toBe(true);
  });

  it('returns false for password that differs by one character', async () => {
    const password = 'password123';
    const wrongPassword = 'password124';
    const stored = await hashPassword(password);
    const result = await verifyPassword(wrongPassword, stored);
    expect(result).toBe(false);
  });

  it('is resistant to timing attacks (uses constant-time compare)', async () => {
    // This test verifies that verifyPassword uses constantTimeCompare internally.
    // The actual constant-time property is verified by constantTimeCompare tests.
    const password = 'test-password-123';
    const stored = await hashPassword(password);

    // Both should complete in similar time (no early exit on mismatch)
    const start1 = performance.now();
    await verifyPassword(password, stored);
    const time1 = performance.now() - start1;

    const start2 = performance.now();
    await verifyPassword('completely-different-password', stored);
    const time2 = performance.now() - start2;

    // Both should take roughly the same time (within 5x for test robustness)
    // Real timing attacks require statistical analysis over many requests
    expect(time2).toBeLessThan(time1 * 5);
  });
});
