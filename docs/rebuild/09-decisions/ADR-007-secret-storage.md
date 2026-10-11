# ADR-007 — Encrypted Credentials + Secrets Store

## Status

Encryption storage is accepted. Rotation/re-encryption is a design requirement,
not delivered tooling: the release CLI currently refuses encryption-key rotation
until a tested key-version and re-encryption migration is available. See the
[deployment runbook](../../operations/deploy.md).

Accepted.

## Context

The legacy system stores provider API keys, S3 access keys, Turnstile secrets, Telegram bot tokens, and webhook signing secrets in plaintext in the `setting` table. Anyone with `setting:query` permission (any admin) can read all secrets.

## Decision

We adopt **two-layer secret storage**:

1. **Encryption keys** live in Cloudflare Secrets Store (`CREDENTIAL_ENCRYPTION_KEY`). Never in `wrangler.toml`.
2. **Encrypted payloads** live in the `encrypted_credentials` D1 table. AES-GCM ciphertext with version field.

```typescript
class EncryptedCredentialStore {
  async encrypt(plaintext: string): Promise<{ ciphertext: string, version: number }> { ... }
  async decrypt(credentialId: string): Promise<string> { ... }
}
```

The `setting` table stores only references (`credential_id`), never plaintext.

## Consequences

### Positive

- Even DB administrators cannot read secrets without the encryption key.
- Encryption keys are managed by Cloudflare (rotation, audit).
- D1 Time Travel bookmarks do not leak secrets.

### Negative

- Encryption/decryption adds CPU overhead per provider call (negligible at our scale).
- Key rotation requires re-encryption of all secrets.

### Mitigations

- Cache decrypted credentials in-memory for the lifetime of a request.
- Re-encryption during rotation is a one-shot `maintenance_job`.

## Alternatives considered

- **Secrets Store for everything**: deferred. Secrets Store is read by SDK at runtime; doesn't fit D1 row model.
- **HashiCorp Vault**: rejected. Adds external dependency.
- **Plaintext with role check**: rejected. Still requires DB admin trust.