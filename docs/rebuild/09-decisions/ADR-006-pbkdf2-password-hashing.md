# ADR-006 — PBKDF2-SHA256 Password Hashing

## Status

Accepted.

## Context

The legacy system uses single-round SHA-256 with non-constant-time compare. A GPU can compute billions of guesses per second, making password leaks catastrophic.

## Decision

We adopt **PBKDF2-SHA256** with:

- Salt: ≥16 random bytes per user.
- Iterations: 600_000 (modern minimum).
- Hash stored alongside algorithm + iteration count.
- Verification uses `crypto.subtle.timingSafeEqual` (constant-time).

```typescript
async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iterations = 600_000
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

- Slower than legacy (600ms vs 1ms per hash). Login latency increases by ~600ms.
- May exceed the 30s Workers CPU budget if iterations increase.

### Mitigations

- Cache the perm set per user for 60s (not the password hash) — first login is slow, subsequent are fast.
- Rehash on next login if iteration count increases.
- Monitor P95 login latency in Phase 6.

## Alternatives considered

- **Argon2**: rejected. Not native to Web Crypto; would require WASM. Possible future migration.
- **scrypt**: rejected. Not native to Web Crypto; would require WASM.
- **bcrypt**: rejected. Not native to Web Crypto; would require WASM.
- **Bcrypt + WASM**: deferred to Phase 6+ if PBKDF2 proves insufficient.