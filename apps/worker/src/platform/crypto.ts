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
