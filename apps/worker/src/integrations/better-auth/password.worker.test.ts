// apps/worker/src/integrations/better-auth/password.worker.test.ts
//
// CAP-042 / Claude Code task 2 — ADR-006 credential-envelope adapter.
//
// Proves that the Better Auth password callback shape, wired through this
// adapter, accepts the legacy column-shaped PasswordHash produced by the
// platform hashPassword (PBKDF2-SHA256, 600_000 iterations, 16-byte salt,
// 32-byte hash) via the canonical envelope, and rejects malformed envelopes
// without ever throwing on untrusted stored data. Runs inside workerd
// against the real WebCrypto — no mocks, no fixture bypass.
//
// The envelope is self-describing: the iteration segment is part of the
// wire format, and the verifier rejects any non-ADR-006 count — 599_999,
// 600_001, or 1_000_000_000 — before invoking WebCrypto.
//
// CAP-042 acceptance criterion #5.

import { describe, expect, it } from 'vitest';
import { hashPassword as platformHashPassword } from '../../platform/crypto';
import { betterAuthPassword, encodeAdr006Password } from './password';

const PASSWORD = 'correct-horse-battery-staple-9!';
const WRONG_PASSWORD = 'wrong-horse-battery-staple-9!';

// Mirrors the production constant. The envelope is
// `pbkdf2-sha256$600000$<32 lowercase hex salt>$<64 lowercase hex hash>`.
const CANONICAL_ENVELOPE_RE = /^pbkdf2-sha256\$600000\$[0-9a-f]{32}\$[0-9a-f]{64}$/;

describe('encodeAdr006Password', () => {
  it('emits the canonical envelope from a legacy hashPassword fixture', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    const encoded = encodeAdr006Password(stored);

    expect(encoded).toMatch(CANONICAL_ENVELOPE_RE);
  });

  it('throws on a non-`pbkdf2-sha256` algorithm', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    expect(() =>
      encodeAdr006Password({ ...stored, algorithm: 'pbkdf2-sha512' as never }),
    ).toThrow();
  });

  it('throws when iterations differ from the ADR-006 minimum', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    expect(() => encodeAdr006Password({ ...stored, iterations: 1 })).toThrow();
    expect(() => encodeAdr006Password({ ...stored, iterations: 600_001 })).toThrow();
  });

  it('throws when the salt is not exactly 16 bytes', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    expect(() => encodeAdr006Password({ ...stored, salt: new Uint8Array(15) })).toThrow();
    expect(() => encodeAdr006Password({ ...stored, salt: new Uint8Array(17) })).toThrow();
  });

  it('throws when the hash is not exactly 32 bytes', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    expect(() => encodeAdr006Password({ ...stored, hash: new Uint8Array(31) })).toThrow();
    expect(() => encodeAdr006Password({ ...stored, hash: new Uint8Array(33) })).toThrow();
  });
});

describe('betterAuthPassword.hash', () => {
  it('emits a canonical envelope that verifies against the original password', async () => {
    const encoded = await betterAuthPassword.hash(PASSWORD);

    expect(encoded).toMatch(CANONICAL_ENVELOPE_RE);

    const ok = await betterAuthPassword.verify({ password: PASSWORD, hash: encoded });
    expect(ok).toBe(true);
  });

  it('emits an envelope that does NOT verify against a different password', async () => {
    const encoded = await betterAuthPassword.hash(PASSWORD);
    const ok = await betterAuthPassword.verify({ password: WRONG_PASSWORD, hash: encoded });
    expect(ok).toBe(false);
  });
});

describe('betterAuthPassword.verify', () => {
  it('returns true for a legacy-column-shaped fixture re-encoded and re-verified', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    const encoded = encodeAdr006Password(stored);

    const ok = await betterAuthPassword.verify({ password: PASSWORD, hash: encoded });
    expect(ok).toBe(true);
  });

  it('returns false for the wrong password against a re-encoded fixture', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    const encoded = encodeAdr006Password(stored);

    const ok = await betterAuthPassword.verify({ password: WRONG_PASSWORD, hash: encoded });
    expect(ok).toBe(false);
  });

  it('returns false (no throw) for a malformed algorithm segment', async () => {
    const stored = await platformHashPassword(PASSWORD, 600_000);
    const encoded = encodeAdr006Password(stored);
    // encoded is `pbkdf2-sha256$600000$<salt>$<hash>` — segments 2 and 3
    // are the salt and hash hex strings.
    const [, , salt, hash] = encoded.split('$');
    const malformed = `pbkdf2-sha512$600000$${salt}$${hash}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when a hex segment contains a non-hex character', async () => {
    const malformed = `pbkdf2-sha256$600000$${'g'.repeat(32)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when the salt segment has the wrong length', async () => {
    const malformed = `pbkdf2-sha256$600000$${'a'.repeat(30)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when the hash segment has the wrong length', async () => {
    const malformed = `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(62)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when the delimiters are wrong', async () => {
    const malformed = `pbkdf2-sha256$600000#${'a'.repeat(32)}#${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when a segment is uppercase hex', async () => {
    const malformed = `pbkdf2-sha256$600000$${'A'.repeat(32)}$${'B'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) for an empty string', async () => {
    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: '' })).resolves.toBe(false);
  });

  it('returns false (no throw) when the iteration segment is one below the ADR-006 minimum', async () => {
    // The canonical envelope encodes the 600_000 iteration count on the
    // wire. Any other count — even one off — is rejected before WebCrypto
    // is asked to derive against an unknown cost.
    const malformed = `pbkdf2-sha256$599999$${'a'.repeat(32)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when the iteration segment is one above the ADR-006 minimum', async () => {
    const malformed = `pbkdf2-sha256$600001$${'a'.repeat(32)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when the iteration segment is enormous', async () => {
    // A 1_000_000_000-iteration envelope is rejected by the canonical gate
    // before WebCrypto is asked to spin for an unbounded duration.
    const malformed = `pbkdf2-sha256$1000000000$${'a'.repeat(32)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when an extra segment is appended', async () => {
    // Five segments where the canonical envelope has four. The anchored
    // regex rejects any deviation from the exact 4-segment shape.
    const malformed = `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}$extra`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when a segment is missing', async () => {
    // Three segments where the canonical envelope has four. The hash
    // segment is dropped so the regex's hash tail cannot match.
    const malformed = `pbkdf2-sha256$600000$${'a'.repeat(32)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) for leading whitespace', async () => {
    // The anchored regex must reject any leading non-envelope byte.
    const malformed = ` pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) for trailing whitespace', async () => {
    const malformed = `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)} `;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) for a PHC-style leading dollar', async () => {
    // PHC strings start with `$<algorithm>$...`. Our canonical envelope
    // deliberately omits the leading dollar so the algorithm segment is
    // unambiguous; the anchored regex must reject a stray leading `$`.
    const malformed = `$pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) for mixed-case hex in the salt segment', async () => {
    // The canonical envelope is all-lowercase hex. A attacker- or
    // migration-supplied envelope with mixed case must not reach
    // WebCrypto, since our comparison is case-sensitive.
    const malformed = `pbkdf2-sha256$600000$${'aA'.repeat(16)}$${'b'.repeat(64)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) for mixed-case hex in the hash segment', async () => {
    const malformed = `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'bB'.repeat(32)}`;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });

  it('returns false (no throw) when a non-string is cast into the hash slot', async () => {
    // Stored data is attacker-controllable. Even if a future caller or
    // adapter hands us a non-string `hash`, the verifier must short-
    // circuit to `false` without throwing and without invoking WebCrypto.
    const malformed = 0xdeadbeef as unknown as string;

    await expect(betterAuthPassword.verify({ password: PASSWORD, hash: malformed })).resolves.toBe(
      false,
    );
  });
});
