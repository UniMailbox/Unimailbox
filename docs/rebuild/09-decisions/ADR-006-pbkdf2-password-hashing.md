# ADR-006 — PBKDF2-SHA256 Password Hashing

## Status

Accepted; hosted Workers adjustment accepted 2026-10-06.

## Context

The legacy system uses single-round SHA-256 with non-constant-time compare. A GPU can compute billions of guesses per second, making password leaks catastrophic.

## Decision

We adopt **PBKDF2-SHA256** with:

- Salt: ≥16 random bytes per user.
- New application passwords: 100,000 iterations, matching the deployed native
  Workers compatibility limit approved on 2026-10-06.
- Existing hashes retain their stored work factor; the platform has a compatible
  derivation fallback for higher counts. Migration-only Better Auth envelopes
  retain 600,000 and are not the runtime login system.
- Hash stored alongside algorithm + iteration count.
- Verification uses the platform constant-time comparison helper.

```typescript
async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iterations = 100_000
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    256,
  )
  return { algorithm: 'pbkdf2-sha256', iterations, salt, hash: new Uint8Array(hash) }
}
```

## Consequences

### Positive

- Industry-standard, Cloudflare Workers compatible.
- Iteration count tunable.
- Constant-time verification.

### Negative

- Password derivation costs CPU and increases login latency. Measure the deployed
  runtime; the original 600 ms estimate is not current benchmark evidence.
- Raising the work factor requires native compatibility and configured CPU-budget checks.

### Mitigations

- Keep permission checks authoritative in D1; permission caching does not reduce
  password derivation work.
- A future work-factor change needs an explicit rehash/migration plan; automatic
  rehash on login is not currently implemented.
- Monitor P95 login latency in Phase 6.

## Alternatives considered

- **Argon2**: rejected. Not native to Web Crypto; would require WASM. Possible future migration.
- **scrypt**: rejected. Not native to Web Crypto; would require WASM.
- **bcrypt**: rejected. Not native to Web Crypto; would require WASM.
- **Bcrypt + WASM**: deferred to Phase 6+ if PBKDF2 proves insufficient.
