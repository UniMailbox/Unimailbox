# Deploy Runbook

This runbook documents how to deploy Unimailbox to a Cloudflare account. The deploy script (CAP-005) provisions all required resources, generates secrets, and deploys the worker with no manual `.env` edits.

## Prerequisites

1. **Cloudflare account** with Workers enabled
2. **wrangler CLI** installed (`pnpm exec wrangler --version` should report >= 4.121.0)
3. **Authenticated** to Cloudflare: `pnpm exec wrangler login`
4. **Node.js >= 20.11.0** and **pnpm >= 9.0.0**

## Secrets

The deploy script generates two secrets in Cloudflare Secrets Store:

| Secret | Purpose | Format | When regenerated |
|---|---|---|---|
| `INSTALLATION_TOKEN` | Token used to claim installation via `POST /setup/claim` | 32 bytes, hex-encoded (64 chars) | First deploy only, or with `--force-secrets` |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM key for encrypting provider credentials in `encrypted_credentials` table (per ADR-007) | 32 bytes, hex-encoded (64 chars) | First deploy only, or with `--force-secrets` |

**Never** commit these secrets. They live in Cloudflare Secrets Store, not in the repository.

## First deploy

```bash
# Set the target environment (prevents accidental local deploys)
export ENVIRONMENT=preview

# Run the deploy script
pnpm scaffold deploy
```

What happens:

1. **Auth check** — verifies you're logged in to Cloudflare
2. **Resource provisioning** — creates or detects:
   - D1 database: `unimailbox-db`
   - R2 bucket: `unimailbox-attachments`
   - KV namespace: `SETUP_SESSION`
   - KV namespace: `CACHE`
   - Queue: `unimailbox-outbound`
   - Secrets Store: `unimailbox-secrets`
3. **Secret generation** — creates `INSTALLATION_TOKEN` and `CREDENTIAL_ENCRYPTION_KEY`
4. **Config resolution** — generates `.wrangler.resolved.jsonc` (gitignored)
5. **Remote migrations** — applies all migrations in `migrations/` to the remote D1 database
6. **Worker deploy** — deploys using `wrangler deploy --config .wrangler.resolved.jsonc`
7. **Resource state** — saves resource IDs to `.cloudflare-resources.json` (gitignored)

The script is idempotent. If resources already exist, they are reused by name.

## Re-deploy

Re-running the same command detects existing resources and reuses them:

```bash
ENVIRONMENT=preview pnpm scaffold deploy
```

No resources are recreated. Only the worker is re-deployed.

## Flags

| Flag | Purpose |
|---|---|
| `--force-secrets` | Regenerate and overwrite existing secrets (use with caution) |
| `--dry-run` | Show what would be done without making changes |
| `--skip-migrate` | Deploy without running remote migrations |

Example — dry-run to preview changes:

```bash
ENVIRONMENT=preview pnpm scaffold deploy --dry-run
```

Example — force regenerate secrets (after rotation):

```bash
ENVIRONMENT=preview pnpm scaffold deploy --force-secrets
```

## Inspecting secrets

To view the current secrets in the Secrets Store:

```bash
# List all secrets in the store
pnpm exec wrangler secrets-store secret list <store-id>

# Get a specific secret (prompts for confirmation)
pnpm exec wrangler secrets-store secret get <store-id> --name INSTALLATION_TOKEN
pnpm exec wrangler secrets-store secret get <store-id> --name CREDENTIAL_ENCRYPTION_KEY
```

The `<store-id>` is saved in `.cloudflare-resources.json` as `secretsStoreId`.

## Rotating secrets

After rotating `CREDENTIAL_ENCRYPTION_KEY`, you must re-encrypt all credentials in the `encrypted_credentials` table. **If CREDENTIAL_ENCRYPTION_KEY is rotated without re-encrypting, all encrypted credentials will become permanently undecryptable** (ADR-007). A re-encryption maintenance job does not yet exist — do NOT rotate this key until it is implemented (future capability).

For `INSTALLATION_TOKEN` rotation, invalidate the old token by deleting it from the Secrets Store and redeploy with `--force-secrets`, or update the `installation_state` table to mark the token as used.

**Shared-machine risk:** The deploy command passes secrets to wrangler. On shared machines (CI runners, shared dev servers), other users with process-list access may observe wrangler's behavior. Use an isolated environment for production deploys.

**Multi-account:** On a multi-account Cloudflare login, set `CLOUDFLARE_ACCOUNT_ID` to target the correct account.

## Healthz check limitation

The deploy script attempts to verify the worker via a `/healthz` endpoint after deployment. This verification only runs when the worker has a `*.workers.dev` URL (`workers_dev: true`) or a custom domain. With the default config (`workers_dev: false`), the healthz check is skipped and the operator must verify manually after configuring a route.

## Troubleshooting

### "Not authenticated to Cloudflare"

```
Not authenticated to Cloudflare. Run `wrangler login` first.
```

Run `pnpm exec wrangler login` and follow the browser authentication flow.

### "Refusing to deploy: ENVIRONMENT=local"

The script refuses to deploy when `ENVIRONMENT` is unset or set to `local`. This prevents accidental production deploys from local development.

Set `ENVIRONMENT` to your target environment:

```bash
export ENVIRONMENT=preview    # or staging, production, etc.
pnpm scaffold deploy
```

### "Failed to apply migration <file>"

A migration failed to apply. Check the migration file for syntax errors and ensure D1 is available in your account. Re-run the deploy — migrations are tracked and will not re-apply.

### Worker URL not found

The deploy script attempts to extract the worker URL from `wrangler deploy` output. If it cannot, the healthz check is skipped. To find your worker URL manually:

```bash
pnpm exec wrangler deployments list --config apps/worker/.wrangler.resolved.jsonc
```

Or construct it from the worker name: `https://unimailbox-worker.<subdomain>.workers.dev`

### Resource already exists with different configuration

If a resource exists but has conflicting settings, the script will fail. Manually inspect or delete the resource in the Cloudflare dashboard, then re-run the deploy.

## Files created/modified

| File | Purpose | Committed? |
|---|---|---|
| `.cloudflare-resources.json` | Stores provisioned resource IDs for idempotent re-runs | No (gitignored) |
| `apps/worker/.wrangler.resolved.jsonc` | Resolved wrangler config with real resource IDs | No (gitignored) |
| `apps/worker/wrangler.jsonc` | Template config (never modified by deploy script) | Yes |

## Verification

After deploy, verify the worker is running:

```bash
# Healthz check (if URL was printed during deploy)
curl https://<worker-url>/healthz

# Expected response
{"ok":true}
```

If the healthz check fails, check the worker logs:

```bash
pnpm exec wrangler tail --config apps/worker/.wrangler.resolved.jsonc
```

## CI/CD

This runbook covers manual deploys. Future capabilities will add CI/CD pipeline integration (GitHub Actions, automated deploys on merge to main).
