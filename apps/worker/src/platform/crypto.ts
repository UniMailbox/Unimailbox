// platform/crypto — constant-time comparison, ADR-006 (PBKDF2-SHA256),
// ADR-007 (AES-GCM via Secrets Store). Real hashing/encryption lands with
// the identity module.

/**
 * Constant-time string comparison. Compares UTF-8 byte sequences with XOR
 * accumulation — no early exit on character mismatch. Returns false immediately
 * on length mismatch (the length of the user's input is not secret).
 *
 * Security rule: never use === for token/password comparison.
 * See .claude/rules/security.md §Passwords and ADR-006.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    const byteA = bufA[i] ?? 0;
    const byteB = bufB[i] ?? 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PBKDF2-SHA256 password hashing — ADR-006
// ---------------------------------------------------------------------------

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BITS = 256;

/**
 * PasswordHash — the result of hashing a password with PBKDF2-SHA256.
 * Stored in the users table as four separate columns.
 */
export interface PasswordHash {
  readonly algorithm: 'pbkdf2-sha256';
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

/**
 * Hash a password using PBKDF2-SHA256 per ADR-006.
 *
 * - Salt: 16 random bytes per user
 * - Iterations: 600,000 (modern minimum)
 * - Hash: 256-bit (32 bytes) derived via SHA-256
 *
 * This function takes ~600ms on Cloudflare Workers. Do NOT reduce iterations
 * for tests — testing.md §Determinism requires we test what we ship.
 *
 * See .claude/rules/security.md §Passwords and ADR-006.
 * Uses the Web Crypto API directly — no external dependencies.
 *
 * @param password - The plaintext password to hash (8–72 characters enforced by API)
 * @returns A PasswordHash containing algorithm, iterations, salt, and hash
 */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    PBKDF2_HASH_BITS,
  );
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt,
    hash: new Uint8Array(hashBuffer),
  };
}
