// apps/worker/src/integrations/better-auth/password.ts
//
// CAP-042 / Claude Code task 2 — ADR-006 credential-envelope adapter.
//
// Bridges Better Auth's `emailAndPassword.password.{hash,verify}` callback
// shape to the existing legacy PBKDF2 password columns by translating the
// platform's `PasswordHash` value object to and from a canonical envelope
// string. The envelope is what Better Auth reads from / writes to its
// `account.password` column.
//
// The encoder (`encodeAdr006Password`) lives in `platform/crypto` (B-1):
// the credential repository (`modules/identity`) and the Better Auth
// integration both depend on it, but neither depends on the other, and
// `platform/*` is below both layers in the dependency direction.
//
// Envelope format (ADR-006 + self-describing for storage safety):
//
//   pbkdf2-sha256$<iterations>$<32 lowercase hex salt bytes>$<64 lowercase hex hash bytes>
//
// - Algorithm name and iteration count are explicit; any deviation is a
//   different envelope.
// - Iterations are encoded on the wire as the ADR-006 minimum (600_000);
//   any deviation — 599_999, 600_001, a huge value, a non-digit run — is
//   rejected as malformed before WebCrypto is invoked. A stored
//   "non-canonical cost" envelope therefore cannot reach WebCrypto.
// - Salt must be exactly 32 lowercase hex chars; hash must be exactly 64
//   lowercase hex chars.
//
// R-SECRET-003: the verifier never logs the candidate password, the stored
// hash, or any segment of either.

import type { BetterAuthOptions } from 'better-auth';
import {
  hashPassword as platformHashPassword,
  verifyPassword as platformVerifyPassword,
  encodeAdr006Password,
  type PasswordHash,
} from '../../platform/crypto';

// Re-export so existing call sites (`password.worker.test.ts`) and the
// legacy production callers continue to import from the integration
// module. The canonical home is `platform/crypto`; this re-export keeps
// the call surface stable.
export { encodeAdr006Password };

// Exact non-null `emailAndPassword.password` option type as declared by
// Better Auth 1.7.1. Pinning our adapter to this type makes any callback
// drift a compile-time error: a `hash` that takes `{ password }` instead of
// `(password: string)`, or a `verify` whose `data` shape changes, will fail
// to satisfy this type and the assignment below will not typecheck.
type BetterAuthEmailPasswordOption = NonNullable<
  NonNullable<BetterAuthOptions['emailAndPassword']>['password']
>;

// Anchored on both ends so any deviation (length, case, delimiter, extra
// segment, missing segment, or non-canonical iteration) is rejected before
// WebCrypto is invoked.
const CANONICAL_RE = /^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;
const ADR006_ITERATIONS = 600_000;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Better Auth password callback surface.
 *
 * - `hash` is a **positional** `(password: string) => Promise<string>` —
 *   Better Auth 1.7.1 invokes it as `hash("plaintext")`, NOT as
 *   `hash({ password: "plaintext" })`. The earlier object-shaped adapter
 *   was a BLOCKER because Better Auth never destructured an argument and
 *   every stored `account.password` would have been the envelope of
 *   `undefined` — silently invalidating every account on first sign-in.
 *   The annotation below pins the callback to the exact non-null
 *   `emailAndPassword.password` option type, so a future regression that
 *   re-introduces an object-shaped `hash` is a compile-time error.
 * - `verify` runs only after the stored string matches the canonical
 *   envelope regex; any deviation — wrong length, uppercase hex, mixed-
 *   case hex, wrong delimiter, extra segment, missing segment, leading or
 *   trailing whitespace, PHC-style leading dollar, non-hex character,
 *   empty string, non-string — returns `false` without invoking WebCrypto
 *   and without throwing. The iteration segment is then compared against
 *   the ADR-006 600_000 invariant; any other value (599_999, 600_001,
 *   1_000_000_000, …) is rejected without invoking WebCrypto. Stored data
 *   is attacker-controllable; the verifier is the trust boundary.
 */
export const betterAuthPassword: BetterAuthEmailPasswordOption = {
  async hash(password: string): Promise<string> {
    const stored = await platformHashPassword(password);
    return encodeAdr006Password(stored);
  },

  async verify({ password, hash }: { password: string; hash: string }): Promise<boolean> {
    if (typeof hash !== 'string' || !CANONICAL_RE.test(hash)) {
      return false;
    }

    // Split on the canonical delimiter. The regex locks the four-segment
    // shape, so this produces exactly ['pbkdf2-sha256', '600000', <salt>,
    // <hash>].
    // Indexing after the regex match is therefore safe; the undefined
    // guards below are defensive against a future regex relaxation.
    const parts = hash.split('$');
    const iterStr = parts[1];
    const saltHex = parts[2];
    const expectedHex = parts[3];
    if (iterStr === undefined || saltHex === undefined || expectedHex === undefined) {
      return false;
    }

    // Self-describing iteration segment. The encoder always writes the
    // ADR-006 minimum; any deviation here — 599_999, 600_001, 1_000_000_000,
    // a non-canonical count lifted from older code — is rejected before
    // WebCrypto can be asked to derive against an unknown cost.
    const storedIterations = Number(iterStr);
    if (!Number.isFinite(storedIterations) || storedIterations !== ADR006_ITERATIONS) {
      return false;
    }

    // The regex has already locked length and hex characters, so these
    // parses cannot NaN. We still gate on the parseInt result as a defensive
    // second layer for the rare case of a malformed UTF-16 surrogate pair
    // slipping past a future regex relaxation.
    const salt = hexToBytes(saltHex);
    const expected = hexToBytes(expectedHex);
    for (let i = 0; i < expected.length; i++) {
      if (!Number.isFinite(expected[i])) return false;
    }

    const stored: PasswordHash = {
      algorithm: 'pbkdf2-sha256',
      iterations: ADR006_ITERATIONS,
      salt,
      hash: expected,
    };

    try {
      return await platformVerifyPassword(password, stored);
    } catch {
      return false;
    }
  },
};
