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
 * @param password - The plaintext password to hash (6–30 characters enforced by API)
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

// ---------------------------------------------------------------------------
// AES-GCM encryption for credential storage — ADR-007
// ---------------------------------------------------------------------------

/**
 * EncryptedData — the result of AES-GCM encryption.
 *
 * Per ADR-007: ciphertext, IV, and auth tag are stored as separate BLOB
 * columns in the encrypted_credentials table. The version field lives
 * on the row itself.
 */
export interface EncryptedData {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly authTag: Uint8Array;
}

/**
 * Import an AES-GCM key from a hex string.
 *
 * The CREDENTIAL_ENCRYPTION_KEY from Secrets Store is a hex-encoded
 * 32-byte key (64 hex characters). This function converts it to a CryptoKey
 * suitable for encrypt/decrypt operations.
 *
 * See ADR-007 §Key format.
 *
 * @param rawKey - Hex-encoded key string (64 characters for AES-256)
 * @returns A CryptoKey for AES-GCM encrypt/decrypt
 */
export async function importEncryptionKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(rawKey.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt plaintext using AES-GCM.
 *
 * - IV: 12 random bytes (recommended for GCM)
 * - Auth tag: 16 bytes (appended by Web Crypto, we split it out)
 *
 * The Web Crypto API returns ciphertext + authTag concatenated; we split
 * them so both can be stored as BLOB columns per ADR-007.
 *
 * @param plaintext - The secret to encrypt (e.g. API key)
 * @param key - The encryption key from importEncryptionKey
 * @returns EncryptedData with separate ciphertext, iv, and authTag
 */
export async function encrypt(plaintext: string, key: CryptoKey): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  // AES-GCM returns ciphertext + authTag concatenated (last 16 bytes = tag)
  const bytes = new Uint8Array(encrypted);
  const ciphertext = bytes.slice(0, bytes.length - 16);
  const authTag = bytes.slice(bytes.length - 16);
  return { ciphertext, iv, authTag };
}

/**
 * Decrypt AES-GCM ciphertext.
 *
 * Re-concatenates ciphertext and authTag for the Web Crypto API, which
 * expects them combined. The IV is passed separately.
 *
 * @param data - EncryptedData with ciphertext, iv, and authTag
 * @param key - The decryption key from importEncryptionKey
 * @returns The original plaintext
 * @throws {DOMException} If authentication fails (wrong key or tampered data)
 */
export async function decrypt(data: EncryptedData, key: CryptoKey): Promise<string> {
  // Re-concatenate ciphertext + authTag for decrypt
  const combined = new Uint8Array(data.ciphertext.length + data.authTag.length);
  combined.set(data.ciphertext);
  combined.set(data.authTag, data.ciphertext.length);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.iv }, key, combined);
  return new TextDecoder().decode(decrypted);
}

// ---------------------------------------------------------------------------
// Password verification — CAP-019
// ---------------------------------------------------------------------------

/**
 * Verify a password against a stored hash using PBKDF2-SHA256.
 *
 * Re-derives the hash from the input password using the stored salt and
 * iterations, then compares using constant-time comparison to prevent timing
 * attacks.
 *
 * @param password - The plaintext password to verify
 * @param stored - The PasswordHash containing algorithm, iterations, salt, and hash
 * @returns true if the password matches, false otherwise
 *
 * See .claude/rules/security.md §Passwords and ADR-006.
 */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: stored.salt,
      iterations: stored.iterations,
      hash: 'SHA-256',
    },
    key,
    PBKDF2_HASH_BITS,
  );

  // constantTimeCompare works with strings, so convert both Uint8Arrays to hex
  const derivedHex = bufferToHex(new Uint8Array(hashBuffer));
  const storedHex = bufferToHex(stored.hash);
  return constantTimeCompare(derivedHex, storedHex);
}

/**
 * Convert a Uint8Array to a hexadecimal string.
 *
 * Used by verifyPassword to convert hash buffers for constant-time comparison.
 */
function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// ADR-006 canonical credential envelope — CAP-042 (B-1, AC 17, 18)
//
// This helper was originally defined in `integrations/better-auth/password.ts`
// alongside the `betterAuthPassword` callback adapter. Moving the encoder into
// `platform/crypto` removes the forbidden `modules/* → integrations/*`
// dependency edge: `identity/credential-repository.ts` (a module) imports
// the encoder, and the encoder no longer reaches back through the
// integration layer. `integrations/better-auth/password.ts` now imports
// from here too, so both sides share one definition with no cycle.
//
// Envelope wire format:
//
//   pbkdf2-sha256$600000$<32 lowercase hex salt bytes>$<64 lowercase hex hash bytes>
//
// The encoder is pure: it accepts the platform `PasswordHash` value object
// and returns a string. The verifier (in `integrations/better-auth/password.ts`)
// still owns the regex gate, the iteration-count guard, and the WebCrypto
// verification path — those are better-auth-specific concerns that belong
// in the integration layer.
// ---------------------------------------------------------------------------

const ADR006_ALGORITHM = 'pbkdf2-sha256';
const ADR006_ITERATIONS = 600_000;
const ADR006_SALT_BYTES = 16;
const ADR006_HASH_BYTES = 32;

/**
 * Encode a platform `PasswordHash` value into the canonical ADR-006 envelope.
 *
 * Throws on any deviation from ADR-006 so column-row mismatches fail loud
 * during migration and backfill rather than silently producing a hash that
 * the verifier will later reject. The iteration segment is always written
 * as the ADR-006 minimum; any other value reaches the wire only as a
 * rejection.
 */
export function encodeAdr006Password(stored: PasswordHash): string {
  if (stored.algorithm !== ADR006_ALGORITHM) {
    throw new Error(`Unsupported algorithm: ${String(stored.algorithm)}`);
  }
  if (stored.iterations !== ADR006_ITERATIONS) {
    throw new Error(`Unsupported iteration count: ${stored.iterations}`);
  }
  if (!(stored.salt instanceof Uint8Array) || stored.salt.byteLength !== ADR006_SALT_BYTES) {
    throw new Error(`Salt must be exactly ${ADR006_SALT_BYTES} bytes`);
  }
  if (!(stored.hash instanceof Uint8Array) || stored.hash.byteLength !== ADR006_HASH_BYTES) {
    throw new Error(`Hash must be exactly ${ADR006_HASH_BYTES} bytes`);
  }
  return `pbkdf2-sha256$${ADR006_ITERATIONS}$${bufferToHex(stored.salt)}$${bufferToHex(stored.hash)}`;
}
