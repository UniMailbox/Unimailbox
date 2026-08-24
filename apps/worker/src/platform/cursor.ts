// platform/cursor — CAP-043 Slice 1 / D-CAP-043-D; multi-surface since
// CAP-044 Slice 2; payload contract promoted into contracts by CAP-044
// Slice 3 (third consumer — listUsers — fired the promotion trigger
// recorded in the Slice 2 review note).
//
// HMAC-SHA-256 signed cursor tokens for cursor-paginated list endpoints
// (R-API-005): the inbox messages list since CAP-043, the audit-events
// list since CAP-044 Slice 2, the admin users list since CAP-044 Slice
// 3. The cursor is opaque to clients yet tamperable by them (it's
// URL-passed); an HMAC over the `(created_at, id, surface)` payload
// prevents a malicious client from jumping the cursor or guessing
// another user's position. The `surface` discriminator (CAP-044 Slice
// 2 fix (d)) prevents a cursor minted by one API from being replayed
// against another — every consumer signs and verifies with its own
// surface ('messages', 'audit-events', 'admin-users') even though all
// share the signing key. The key is independent from
// `CREDENTIAL_ENCRYPTION_KEY` (provider secrets, AES-GCM) and
// `BETTER_AUTH_SECRET` (session-cookie HMAC) so a rotation of one does
// not silently rotate the other.
//
// This file keeps ONLY the crypto (sign / verify / base64url). The
// payload SCHEMA and the closed `CursorSurface` union live in
// `@unimailbox/contracts` (`src/cursor.ts`) so the worker and any
// client agree on one wire shape; `CursorPayload` is re-exported here
// for the existing consumers that import it from this module.
//
// Format: `<base64url(payload)>.<base64url(signature)>` — a single dot
// separator and URL-safe base64 (no `+/=` padding) so the cursor can
// ride a query string unchanged. The signature is the raw HMAC output
// (32 bytes), base64url-encoded; we never truncate or hash it again.
//
// The helpers in this file never throw — `verifyCursor` returns `null`
// for any failure mode (malformed base64, wrong shape, wrong surface,
// signature mismatch) so the route layer surfaces a single 400
// INVALID_CURSOR to the client without distinguishing "bad token" from
// "tampered token".
//
// Deploy note (CAP-044 Slice 2 fix (d)): the payload now REQUIRES the
// `surface` field, so every cursor minted before the field existed
// fails verification. Accepted pre-launch; CAP-045 verifies fresh flows
// end-to-end.

import {
  cursorPayloadSchema,
  type CursorPayload,
  type CursorSurface,
} from '@unimailbox/contracts';

// Re-export for existing consumers (message-read-repository.ts imports
// the type from this module; the canonical home is now contracts).
export type { CursorPayload, CursorSurface } from '@unimailbox/contracts';

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
 * failure (malformed token, malformed payload, surface other than
 * `expectedSurface`, signature mismatch).
 *
 * The function never throws: the route layer maps `null` to a single
 * 400 INVALID_CURSOR response. We do not distinguish "bad shape" from
 * "wrong surface" from "tampered" because all three are observationally
 * equivalent for an attacker and a single error code keeps the API
 * surface stable.
 */
export async function verifyCursor(
  token: string,
  key: string,
  expectedSurface: CursorSurface,
): Promise<CursorPayload | null> {
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

  // 4. Parse the JSON payload and validate it against the contracts
  // schema (CAP-044 Slice 3 amendment — the payload contract is shared
  // with clients, so the shape check is the schema, not a local
  // duplicate). Anything else returns null so a future schema change
  // cannot be silently accepted by a verifier that doesn't know it
  // yet. A payload without `surface` fails here — which intentionally
  // invalidates every pre-surface cursor (accepted pre-launch; see the
  // header note).
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  const parsedPayload = cursorPayloadSchema.safeParse(parsed);
  if (!parsedPayload.success) {
    return null;
  }
  const payload = parsedPayload.data;

  // 5. Surface binding (CAP-044 Slice 2 fix (d)): a token signed for one
  // API must not page another. Both surfaces share the signing key, so
  // the discriminator is the only thing keeping a messages cursor from
  // being accepted as an audit-events boundary (and vice versa).
  if (payload.surface !== expectedSurface) {
    return null;
  }
  return payload;
}