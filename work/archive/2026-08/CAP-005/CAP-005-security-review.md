# CAP-005 — Security Review

**Role**: security-reviewer
**Date**: 2026-08-12
**Reviewer**: Independent (did not write this code)
**Branch**: `cap/CAP-005-deploy`

---

## Status

**ACCEPT WITH FIXES**

---

## Files reviewed

- `scripts/deploy.ts` — deploy automation implementation
- `scripts/deploy.test.ts` — unit tests
- `docs/operations/deploy.md` — operator runbook
- `.gitignore` — gitignore additions

---

## Reading list

1. `work/active/CAP-005-deploy/task.md` — acceptance criteria
2. `.claude/rules/security.md` — ADR-006, ADR-007, secrets handling
3. `docs/rebuild/09-decisions/ADR-007-secret-storage.md` — Secrets Store design
4. `scripts/deploy.ts` — code under review
5. `docs/operations/deploy.md` — runbook

---

## Findings

### [BLOCKER] CLI argument secret leakage via `--value` flag

**Location**: `scripts/deploy.ts:378-383, 421-426, 397-402, 440-445`

**Attack scenario**: The deploy script passes secrets via the `--value` CLI argument to `wrangler secrets-store secret create/update`. This exposes secrets in:

1. **Process list**: Other users on the same machine can see running processes with `ps aux`, potentially logging the secret
2. **Shell history**: Commands with flags may be saved to shell history (`.bash_history`, `.zsh_history`)
3. **Process monitoring**: System monitoring tools that record command lines
4. **Audit logs**: Some systems log full command lines for audit purposes

**Evidence**:
```typescript
const result = wrangler([
  'secrets-store', 'secret', 'create', state.secretsStoreId,
  '--name', 'INSTALLATION_TOKEN',
  '--value', token,  // SECRET EXPOSED IN PROCESS LIST
  '--scopes', 'workers',
]);
```

**Remediation required**: Investigate whether wrangler supports secret input via stdin or environment variable. If not, document this as a known limitation with operator safeguards in the runbook.

---

### [HIGH] Missing user confirmation for `--force-secrets` with data destruction risk

**Location**: `scripts/deploy.ts:391-408, 434-451`

**Attack scenario**: An operator runs `--force-secrets` unintentionally (e.g., typo in command, muscle memory). The script immediately destroys the existing `CREDENTIAL_ENCRYPTION_KEY`. **Any data encrypted with the old key becomes permanently undecryptable** (provider credentials in `encrypted_credentials` table per ADR-007). The operator has no chance to cancel.

**Evidence**: The script regenerates and overwrites immediately without confirmation:
```typescript
} else if (forceSecrets) {
  // Existing + force: update
  const token = generateSecret();
  // ... immediately overwrites without confirmation
}
```

**Remediation required**: Before overwriting any existing secret with `--force-secrets`, require explicit user confirmation via stdin prompt (`readline.createInterface`). The warning must explicitly state that rotating `CREDENTIAL_ENCRYPTION_KEY` will make existing encrypted data unreadable without re-encryption.

---

### [MEDIUM] Runbook documents incomplete secret rotation procedure

**Location**: `docs/operations/deploy.md:96-101`

The runbook states:

> "After rotating `CREDENTIAL_ENCRYPTION_KEY`, you must re-encrypt all credentials in the `encrypted_credentials` table. This is done via a maintenance job (not yet implemented — future capability)."

**Issue**: This tells the operator that rotation is possible, but the required re-encryption job does not exist. An operator who rotates the key will have **permanently corrupted all encrypted credentials**.

**Remediation required**: Add a prominent warning that `CREDENTIAL_ENCRYPTION_KEY` rotation should NOT be performed until the re-encryption job exists. Reference ADR-007's re-encryption design.

---

### [MEDIUM] Runbook should document shared-machine risk

**Location**: `docs/operations/deploy.md`

**Issue**: When deploying on a shared machine (CI/CD runners, shared dev servers), other users with process-list access can see secrets passed via CLI arguments. The runbook does not warn operators about this risk.

**Remediation required**: Add a security note: "When deploying on a shared machine, be aware that the deploy command passes secrets to wrangler via CLI arguments. Other users with process-list access may see these values. Use an isolated environment for production deploys."

---

### [LOW] Runbook example commands could expose ENVIRONMENT with secret

**Location**: `docs/operations/deploy.md:26-29, 53, 72, 78`

**Issue**: Runbook shows:
```bash
export ENVIRONMENT=preview
pnpm scaffold deploy
```

If an operator accidentally puts `export` with the secret value on the same line as the deploy command (e.g., copy-paste error), the secret could be logged.

**Remediation**: Consider adding a note to always set `ENVIRONMENT` on a separate line, and warn against including secret values in export statements visible to other users.

---

### [INFO] Verified: No secret logging or printing

**Location**: `scripts/deploy.ts` (entire secret handling flow)

**Verification**: The code correctly NEVER logs or prints secret values. The generated `token` and `key` variables are only passed to wrangler CLI, never to `console.log`. This is correct per ADR-007 (`R-SECRET-003`).

---

### [INFO] Verified: Config and resource state files contain no secrets

**Locations**:
- `wrangler.resolved.jsonc` generation (`scripts/deploy.ts:463-496`)
- `.cloudflare-resources.json` read/write (`scripts/deploy.ts:83-97`)

**Verification**: Both files contain only resource IDs (strings like `d1-abc123`, `kv-def456`). No secret values. Both files are properly gitignored.

---

### [INFO] Verified: Secret generation is cryptographically sound

**Location**: `scripts/deploy.ts:177-183`

**Verification**:
```typescript
export const generateSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);  // CSPRNG, 32 bytes
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');  // hex-encoded, 64 chars
};
```

- Uses `crypto.getRandomValues` (Web Crypto API CSPRNG) — correct
- 32 bytes = 256 bits — sufficient for AES-256-GCM (ADR-007)
- Hex encoding produces 64-character output — correct
- Test verifies uniqueness and pattern matching (`/^[0-9a-f]{64}$/)

---

## Summary

| Severity | Count |
|----------|-------|
| BLOCKER  | 1     |
| HIGH     | 1     |
| MEDIUM   | 2     |
| LOW      | 1     |

## What must be fixed before acceptance

1. **[BLOCKER]** Investigate wrangler secret input alternatives to `--value` CLI argument
2. **[HIGH]** Add user confirmation prompt for `--force-secrets` with data-loss warning
3. **[MEDIUM]** Update runbook with prominent warning about CREDENTIAL_ENCRYPTION_KEY rotation prerequisites
4. **[MEDIUM]** Add security note about shared-machine risk to runbook

## What looks good

- Secret generation uses `crypto.getRandomValues(32 bytes)` — cryptographically sound for AES-256-GCM
- Config resolution (`wrangler.resolved.jsonc`) contains only resource IDs, no secret values
- Resource state (`.cloudflare-resources.json`) contains only IDs, no secrets
- Both generated files properly gitignored
- ENVIRONMENT guard prevents accidental local deploys
- Code never logs or prints secret values
- Tests verify secret generation uniqueness and format

## Next

Implement the four fixes above, then re-submit for security review. The implementer should:
1. Research wrangler documentation for stdin/env var secret input
2. Add `readline` confirmation for `--force-secrets`
3. Update runbook with rotation warnings and shared-machine security note
4. Add test coverage for confirmation prompt behavior
