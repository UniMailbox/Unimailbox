// platform/cursor — CAP-043 Slice 1 / D-CAP-043-D.
//
// HMAC-SHA-256 signed cursor tokens for the inbox list pagination
// (R-API-005). The cursor is opaque to clients yet tamperable by them
// (it's URL-passed); an HMAC over the `(created_at, id)` payload prevents
// a malicious client from jumping the cursor or guessing another user's
// position. The signing key is independent from `CREDENTIAL_ENCRYPTION_KEY`
// (provider secrets, AES-GCM) and `BETTER_AUTH_SECRET` (session-cookie
// HMAC) so a rotation of one does not silently rotate the other.
//
// Format: `<base64url(payload)>.<base64url(signature)>` — a single dot
// separator and URL-safe base64 (no `+/=` padding) so the cursor can
// ride a query string unchanged. The signature is the raw HMAC output
// (32 bytes), base64url-encoded; we never truncate or hash it again.
//
// The helpers in this file never throw — `verifyCursor` returns `null`
// for any failure mode (malformed base64, wrong shape, signature
// mismatch) so the route layer surfaces a single 400 INVALID_CURSOR to
// the client without distinguishing "bad token" from "tampered token".

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The opaque payload encoded in every cursor. `createdAt` is the SQLite
 * datetime string ('YYYY-MM-DD HH:MM:SS' UTC) the inbox query uses as
 * the page-boundary tie-breaker; `id` is the message UUID (the second
 * sort key for deterministic ordering when two messages share a
 * `created_at`).
 */
export interface CursorPayload {
  readonly createdAt: string;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// URL-safe base64 helpers
// ---------------------------------------------------------------------------

/**
 * Encode a byte sequence as URL-safe base64 without padding.
 *
 * `btoa()` / `atob()` (the Worker's built-in codecs) produce / accept
 * standard base64. We translate between the two alphabets so the cursor
 * can ride a URL query string unchanged. `+` → `-`, `/` → `_`, and
 * trailing `=` padding stripped.
 */
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const standard = btoa(binary);
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  // Restore the standard alphabet + padding so `atob()` decodes it.
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Web Crypto import + sign/verify
// ---------------------------------------------------------------------------

/**
 * Import the cursor signing key as an HMAC-SHA-256 key.
 *
 * The key material is read from `env.CURSOR_SIGNING_KEY` (Secrets Store
 * binding in production, plain string in the worker-pool test). We
 * treat it as raw bytes regardless of the input encoding — UTF-8 for a
 * plain string, raw bytes for a hex string is an operator call.
 */
async function importSigningKey(key: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(key);
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Sign `payload` and return the opaque cursor token.
 *
 * The token encodes the JSON-serialised payload (canonical, no
 * whitespace) as URL-safe base64 followed by the raw HMAC signature
 * (URL-safe base64). The signature covers the JSON payload bytes, NOT
 * the base64-encoded form — both ends re-canonicalise the JSON so any
 * whitespace difference between sign and verify cannot forge a token.
 */
export async function signCursor(payload: CursorPayload, key: string): Promise<string> {
  const json = JSON.stringify(payload);
  const payloadBytes = new TextEncoder().encode(json);
  const signingKey = await importSigningKey(key);
  const signature = await crypto.subtle.sign('HMAC', signingKey, payloadBytes);
  return `${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verify a cursor token and return the payload, or `null` on any
 * failure (malformed token, malformed payload, signature mismatch).
 *
 * The function never throws: the route layer maps `null` to a single
 * 400 INVALID_CURSOR response. We do not distinguish "bad shape" from
 * "tampered" because the two are observationally equivalent for an
 * attacker and a single error code keeps the API surface stable.
 */
export async function verifyCursor(token: string, key: string): Promise<CursorPayload | null> {
  // 1. Split the token at the single dot. A second dot is a malformed
  // token; we reject it without trying to recover.
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;
  const payloadPart = token.slice(0, dotIndex);
  const signaturePart = token.slice(dotIndex + 1);
  if (payloadPart.length === 0 || signaturePart.length === 0) return null;
  if (token.indexOf('.', dotIndex + 1) !== -1) return null;

  // 2. Decode both halves. Any decoding failure (invalid base64) returns
  // null; the route surfaces 400 INVALID_CURSOR.
  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = base64UrlToBytes(payloadPart);
    signatureBytes = base64UrlToBytes(signaturePart);
  } catch {
    return null;
  }

  // 3. Verify the signature against the payload bytes. A mismatch
  // returns false; we map that to null.
  const signingKey = await importSigningKey(key);
  const signatureOk = await crypto.subtle.verify(
    'HMAC',
    signingKey,
    signatureBytes,
    payloadBytes,
  );
  if (!signatureOk) return null;

  // 4. Parse the JSON payload. The schema is a closed object with two
  // string fields; anything else returns null so a future schema change
  // cannot be silently accepted by a verifier that doesn't know it yet.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    return null;
  }
  return {
    createdAt: (parsed as { createdAt: string }).createdAt,
    id: (parsed as { id: string }).id,
  };
}