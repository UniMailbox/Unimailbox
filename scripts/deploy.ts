#!/usr/bin/env node
// scripts/deploy.ts — CAP-005 deploy automation.
//
// Provisions all Cloudflare resources (D1, R2, KV, Queue, Secrets Store)
// idempotently, generates secrets, resolves wrangler.jsonc placeholders,
// runs remote migrations, and deploys the worker.
//
// Usage:
//   ENVIRONMENT=preview pnpm scaffold deploy              # first deploy or re-deploy
//   ENVIRONMENT=preview pnpm scaffold deploy --force-secrets  # regenerate secrets
//   ENVIRONMENT=preview pnpm scaffold deploy --dry-run     # show what would be done
//   ENVIRONMENT=preview pnpm scaffold deploy --skip-migrate  # deploy without running migrations
//
// Environment guard: refuses to run if ENVIRONMENT is unset or 'local'
// (same pattern as db-migrate.ts --reset).
//
// ADR-007: secrets are generated as 32 random bytes, hex-encoded, stored
// in Cloudflare Secrets Store. CREDENTIAL_ENCRYPTION_KEY is the AES-256-GCM
// key for encrypted_credentials; INSTALLATION_TOKEN is the setup claim token.
//
// Resource state persists to .cloudflare-resources.json at repo root so
// re-runs can detect existing resources without re-listing.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = resolve(REPO, 'apps/worker');
const RESOURCE_STATE_PATH = resolve(REPO, '.cloudflare-resources.json');
const RESOLVED_CONFIG_PATH = resolve(WORKER_DIR, '.wrangler.resolved.jsonc');

// F6: Shared migration filename regex (matches db-migrate.ts)
const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;

export interface ResourceState {
  d1DatabaseId?: string;
  kvSetupSessionId?: string;
  kvCacheId?: string;
  r2Bucket?: string;
  queue?: string;
  secretsStoreId?: string;
  secrets?: {
    installationToken: boolean;
    credentialEncryptionKey: boolean;
  };
}

const args = new Set(process.argv.slice(2));
const forceSecrets = args.has('--force-secrets');
const dryRun = args.has('--dry-run');
const skipMigrate = args.has('--skip-migrate');

// ---------------------------------------------------------------------
// ENVIRONMENT guard (matches db-migrate.ts pattern)
// ---------------------------------------------------------------------
export const checkEnvironmentGuard = (env: string | undefined): { ok: boolean; error?: string } => {
  if (!env || env === 'local') {
    return { ok: false, error: `ENVIRONMENT=${env ?? '(unset)'} (must be non-'local')` };
  }
  return { ok: true };
};

// ---------------------------------------------------------------------
// Wrangler CLI wrapper (matches db-migrate.ts pattern)
// ---------------------------------------------------------------------
const wrangler = (subargs: string[]): { status: number | null; stdout: string } => {
  // Merge stderr into stdout to avoid interleaving JSON with error messages
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', ...subargs],
    {
      cwd: WORKER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    },
  );
  const stdout = result.stdout?.toString('utf-8') ?? '';
  const stderr = result.stderr?.toString('utf-8') ?? '';
  return { status: result.status, stdout: stdout + stderr };
};

// F2: Wrangler wrapper for secret commands (stdin input, no CI flag)
// Secrets are piped via stdin to avoid --value CLI flag visibility.
const wranglerSecret = (subargs: string[], secret: string): { status: number | null; stdout: string } => {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', ...subargs],
    {
      cwd: WORKER_DIR,
      input: `${secret}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }, // no CI=1 — let the prompt fire
    },
  );
  const stdout = result.stdout?.toString('utf-8') ?? '';
  const stderr = result.stderr?.toString('utf-8') ?? '';
  return { status: result.status, stdout: stdout + stderr };
};

// ---------------------------------------------------------------------
// Resource state management
// ---------------------------------------------------------------------
export const loadResourceState = (path: string = RESOURCE_STATE_PATH): ResourceState => {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as ResourceState;
  } catch {
    return {};
  }
};

export const saveResourceState = (state: ResourceState, path: string = RESOURCE_STATE_PATH): void => {
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
};

// ---------------------------------------------------------------------
// JSON parsing helpers (matches db-migrate.ts pattern)
// ---------------------------------------------------------------------
interface WranglerListResult<T> {
  success: boolean;
  result?: T[];
  error?: string;
}

function parseWranglerList<T>(
  r: { status: number | null; stdout: string },
  source: string,
): { ok: true; data: T[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    // F4: Include first 200 chars of stdout in parse error for diagnostics
    return { ok: false, error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `expected JSON array from wrangler, got ${typeof parsed}; first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  // First element is the batch wrapper
  const batch = parsed[0] as WranglerListResult<T> | undefined;
  if (!batch) {
    return { ok: false, error: `wrangler output missing first element (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  if (batch.success === false) {
    return { ok: false, error: `wrangler reported success=false: ${batch.error ?? 'unknown error'}` };
  }
  if (!batch.result || !Array.isArray(batch.result)) {
    return { ok: false, error: `wrangler batch missing or invalid 'result' field (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  return { ok: true, data: batch.result };
}

function parseWranglerSingle<T>(
  r: { status: number | null; stdout: string },
  source: string,
): { ok: true; data: T } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    // F4: Include first 200 chars of stdout in parse error for diagnostics
    return { ok: false, error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, error: `expected JSON array with one element from wrangler (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  const batch = parsed[0] as WranglerListResult<T> | undefined;
  if (!batch) {
    return { ok: false, error: `wrangler output missing first element (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  if (batch.success === false) {
    return { ok: false, error: `wrangler reported success=false: ${batch.error ?? 'unknown error'}` };
  }
  if (!batch.result || !Array.isArray(batch.result) || batch.result.length === 0) {
    return { ok: false, error: `wrangler batch missing or invalid 'result' field (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  return { ok: true, data: batch.result[0] as T };
}

// F12: CAP-039 — wrangler's --json output for a SELECT is the documented
// batch shape `[{ results: [...], success: true, meta: {...} }]`. We
// mirror `scripts/db-migrate.ts:parseWranglerJson` + `extractColumn` so the
// remote runner applies the same parse discipline as the local one.
// Unlike `parseWranglerList`, this accepts either `success: true` or
// `success: false` — a missing `d1_migrations` table returns success=false
// with `error` set, and we want to treat that as "empty applied set" so
// the ghost check can run (it's a no-op when applied is empty).
function parseWranglerJson(
  r: { status: number | null; stdout: string },
  source: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { ok: false, error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `expected JSON array from wrangler, got ${typeof parsed}; first 200 chars: ${r.stdout.slice(0, 200)}` };
  }
  for (const batch of parsed) {
    if (batch && typeof batch === 'object' && (batch as { success?: unknown }).success === false) {
      const err = (batch as { error?: unknown }).error;
      return { ok: false, error: `wrangler batch reported success=false: ${typeof err === 'string' ? err : JSON.stringify(err)}` };
    }
    if (!batch || typeof batch !== 'object' || !('results' in batch)) {
      return { ok: false, error: `wrangler batch missing 'results' key (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}` };
    }
  }
  return { ok: true, data: parsed };
}

function extractColumn(parsed: unknown, col: string): string[] {
  const out: string[] = [];
  if (!Array.isArray(parsed)) return out;
  for (const batch of parsed) {
    if (batch && typeof batch === 'object' && 'results' in batch) {
      const results = (batch as { results: unknown }).results;
      if (Array.isArray(results)) {
        for (const r of results) {
          if (r && typeof r === 'object' && col in r) {
            const v = (r as Record<string, unknown>)[col];
            if (typeof v === 'string') out.push(v);
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------
const checkAuth = (): void => {
  console.log('Checking Cloudflare authentication…');
  const r = wrangler(['whoami']);
  if (r.status !== 0) {
    console.error('Not authenticated to Cloudflare. Run `wrangler login` first.');
    process.exit(1);
  }
  console.log('Authenticated.');
};

// ---------------------------------------------------------------------
// Secret generation (ADR-007)
// ---------------------------------------------------------------------
export const generateSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// ---------------------------------------------------------------------
// Resource provisioning (idempotent)
// ---------------------------------------------------------------------
// F3: D1 uses 'uuid' field name, not 'id'
interface D1Database { uuid: string; name: string }
interface KvNamespace { id: string; title: string }
interface Queue { queue_name: string }
interface SecretsStore { id: string; name: string }

const provisionD1 = (state: ResourceState): ResourceState => {
  console.log('Provisioning D1 database…');
  if (state.d1DatabaseId) {
    console.log(`  Reusing existing database: ${state.d1DatabaseId}`);
    return state;
  }

  // Try to find existing by name
  const listResult = wrangler(['d1', 'list', '--json']);
  const parsed = parseWranglerList<D1Database>(listResult, 'd1-list');
  if (parsed.ok) {
    const existing = parsed.data.find((db) => db.name === 'unimailbox-db');
    if (existing) {
      console.log(`  Found existing database: ${existing.uuid}`);
      return { ...state, d1DatabaseId: existing.uuid };
    }
  } else {
    // F4: Parse failures must be visible, not silently swallowed
    console.error(`Warning: could not parse wrangler list output for d1 (${parsed.error}).`);
    console.error('Proceeding to create. If the database already exists, create will fail.');
    console.error('Delete .cloudflare-resources.json and re-run if needed.');
  }

  if (dryRun) {
    console.log('  [dry-run] Would create D1 database: unimailbox-db');
    return { ...state, d1DatabaseId: '<dry-run-id>' };
  }

  // F3: Parse text output from d1 create (no --json flag)
  const createResult = wrangler(['d1', 'create', 'unimailbox-db']);
  const match = createResult.stdout.match(/database_id\s*=\s*"([a-f0-9-]+)"/);
  if (!match) {
    console.error(`Failed to create D1 database: could not parse database_id from output`);
    console.error(`First 200 chars of output: ${createResult.stdout.slice(0, 200)}`);
    process.exit(createResult.status ?? 1);
  }
  const databaseId = match[1];
  console.log(`  Created database: ${databaseId}`);
  return { ...state, d1DatabaseId: databaseId } as ResourceState;
};

const provisionR2 = (state: ResourceState): ResourceState => {
  console.log('Provisioning R2 bucket…');
  if (state.r2Bucket) {
    console.log(`  Reusing existing bucket: unimailbox-attachments`);
    return state;
  }

  // R2 bucket create is idempotent, so we can just run it
  if (dryRun) {
    console.log('  [dry-run] Would create R2 bucket: unimailbox-attachments');
    return { ...state, r2Bucket: 'unimailbox-attachments' };
  }

  const result = wrangler(['r2', 'bucket', 'create', 'unimailbox-attachments']);
  if (result.status !== 0) {
    // F10: Try JSON parse for exact name match, fallback to substring
    const listResult = wrangler(['r2', 'bucket', 'list', '--json']);
    interface R2Bucket { name: string }
    const parsed = parseWranglerList<R2Bucket>(listResult, 'r2-list');
    if (parsed.ok) {
      const existing = parsed.data.find((b) => b.name === 'unimailbox-attachments');
      if (existing) {
        console.log('  Bucket already exists: unimailbox-attachments');
        return { ...state, r2Bucket: 'unimailbox-attachments' };
      }
    } else {
      // F4: Warn about parse failure before falling back
      console.error(`Warning: could not parse wrangler list output for r2 (${parsed.error}).`);
    }
    // Fallback to substring match with warning
    if (listResult.stdout.includes('unimailbox-attachments')) {
      console.log('  Bucket already exists: unimailbox-attachments (detected via substring fallback)');
      return { ...state, r2Bucket: 'unimailbox-attachments' };
    }
    console.error(`Failed to create R2 bucket. Exit code: ${result.status}`);
    process.exit(result.status ?? 1); // F12: propagate wrangler status
  }
  console.log('  Created bucket: unimailbox-attachments');
  return { ...state, r2Bucket: 'unimailbox-attachments' };
};

const provisionKv = (state: ResourceState, binding: 'SETUP_SESSION' | 'CACHE', title: string): ResourceState => {
  console.log(`Provisioning KV namespace: ${binding}…`);
  const existingId = binding === 'SETUP_SESSION' ? state.kvSetupSessionId : state.kvCacheId;
  if (existingId) {
    console.log(`  Reusing existing KV namespace: ${existingId}`);
    return state;
  }

  // Try to find existing by title
  const listResult = wrangler(['kv', 'namespace', 'list', '--json']);
  const parsed = parseWranglerList<KvNamespace>(listResult, 'kv-list');
  if (parsed.ok) {
    const existing = parsed.data.find((ns) => ns.title === title);
    if (existing) {
      console.log(`  Found existing KV namespace: ${existing.id}`);
      return binding === 'SETUP_SESSION'
        ? { ...state, kvSetupSessionId: existing.id }
        : { ...state, kvCacheId: existing.id };
    }
  } else {
    // F4: Parse failures must be visible
    console.error(`Warning: could not parse wrangler list output for kv (${parsed.error}).`);
    console.error('Proceeding to create. If the namespace already exists, create will fail.');
    console.error('Delete .cloudflare-resources.json and re-run if needed.');
  }

  if (dryRun) {
    console.log(`  [dry-run] Would create KV namespace: ${title}`);
    return binding === 'SETUP_SESSION'
      ? { ...state, kvSetupSessionId: '<dry-run-id>' }
      : { ...state, kvCacheId: '<dry-run-id>' };
  }

  const createResult = wrangler(['kv', 'namespace', 'create', title, '--json']);
  const created = parseWranglerSingle<KvNamespace>(createResult, 'kv-create');
  if (!created.ok) {
    console.error(`Failed to create KV namespace: ${created.error}`);
    process.exit(createResult.status ?? 1); // F12: propagate wrangler status
  }
  console.log(`  Created KV namespace: ${created.data.id}`);
  return binding === 'SETUP_SESSION'
    ? { ...state, kvSetupSessionId: created.data.id }
    : { ...state, kvCacheId: created.data.id };
};

const provisionQueue = (state: ResourceState): ResourceState => {
  console.log('Provisioning Queue…');
  if (state.queue) {
    console.log(`  Reusing existing queue: unimailbox-outbound`);
    return state;
  }

  // Try to find existing by name
  const listResult = wrangler(['queues', 'list', '--json']);
  const parsed = parseWranglerList<Queue>(listResult, 'queues-list');
  if (parsed.ok) {
    const existing = parsed.data.find((q) => q.queue_name === 'unimailbox-outbound');
    if (existing) {
      console.log('  Found existing queue: unimailbox-outbound');
      return { ...state, queue: 'unimailbox-outbound' };
    }
  } else {
    // F4: Parse failures must be visible
    console.error(`Warning: could not parse wrangler list output for queues (${parsed.error}).`);
    console.error('Proceeding to create. If the queue already exists, create will fail.');
    console.error('Delete .cloudflare-resources.json and re-run if needed.');
  }

  if (dryRun) {
    console.log('  [dry-run] Would create queue: unimailbox-outbound');
    return { ...state, queue: 'unimailbox-outbound' };
  }

  const result = wrangler(['queues', 'create', 'unimailbox-outbound']);
  if (result.status !== 0) {
    console.error(`Failed to create queue. Exit code: ${result.status}`);
    process.exit(result.status ?? 1); // F12: propagate wrangler status
  }
  console.log('  Created queue: unimailbox-outbound');
  return { ...state, queue: 'unimailbox-outbound' };
};

const provisionSecretsStore = (state: ResourceState): ResourceState => {
  console.log('Provisioning Secrets Store…');
  if (state.secretsStoreId) {
    console.log(`  Reusing existing Secrets Store: ${state.secretsStoreId}`);
    return state;
  }

  // Try to find existing by name
  const listResult = wrangler(['secrets-store', 'store', 'list', '--json']);
  const parsed = parseWranglerList<SecretsStore>(listResult, 'secrets-store-list');
  if (parsed.ok) {
    const existing = parsed.data.find((s) => s.name === 'unimailbox-secrets');
    if (existing) {
      console.log(`  Found existing Secrets Store: ${existing.id}`);
      return { ...state, secretsStoreId: existing.id };
    }
  } else {
    // F4: Parse failures must be visible
    console.error(`Warning: could not parse wrangler list output for secrets-store (${parsed.error}).`);
    console.error('Proceeding to create. If the Secrets Store already exists, create will fail.');
    console.error('Delete .cloudflare-resources.json and re-run if needed.');
  }

  if (dryRun) {
    console.log('  [dry-run] Would create Secrets Store: unimailbox-secrets');
    return { ...state, secretsStoreId: '<dry-run-id>' };
  }

  const createResult = wrangler(['secrets-store', 'store', 'create', 'unimailbox-secrets', '--json']);
  const created = parseWranglerSingle<SecretsStore>(createResult, 'secrets-store-create');
  if (!created.ok) {
    console.error(`Failed to create Secrets Store: ${created.error}`);
    process.exit(createResult.status ?? 1); // F12: propagate wrangler status
  }
  console.log(`  Created Secrets Store: ${created.data.id}`);
  return { ...state, secretsStoreId: created.data.id };
};

// ---------------------------------------------------------------------
// Secret setting (idempotent unless --force-secrets)
// ---------------------------------------------------------------------

// F8: Pure function to compute secret action (create/update/skip)
export type SecretAction = 'create' | 'update' | 'skip';

export const computeSecretAction = (
  secretExists: boolean,
  forceSecrets: boolean,
  _dryRun: boolean,
): SecretAction => {
  if (!secretExists) {
    // Not set: create (dry-run will flag it separately)
    return 'create';
  }
  if (forceSecrets) {
    // Set + force: update (dry-run will flag it separately)
    return 'update';
  }
  // Set + no force: skip
  return 'skip';
};

const setSecrets = (state: ResourceState): ResourceState => {
  console.log('Setting secrets…');
  if (!state.secretsStoreId) {
    console.error('Cannot set secrets: no Secrets Store ID');
    process.exit(1);
  }

  const secrets = state.secrets ?? { installationToken: false, credentialEncryptionKey: false };

  // INSTALLATION_TOKEN
  const tokenAction = computeSecretAction(secrets.installationToken, forceSecrets, dryRun);
  if (tokenAction === 'create') {
    const token = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would set INSTALLATION_TOKEN');
    } else {
      // F2: Use wranglerSecret wrapper (stdin input, no --value flag)
      const result = wranglerSecret([
        'secrets-store', 'secret', 'create', state.secretsStoreId,
        '--name', 'INSTALLATION_TOKEN',
        '--scopes', 'workers',
      ], token);
      if (result.status !== 0) {
        console.error('Failed to set INSTALLATION_TOKEN');
        process.exit(result.status ?? 1); // F12: propagate status
      }
      console.log('  Set INSTALLATION_TOKEN');
      secrets.installationToken = true; // F1: Only flip flag when actually set
    }
  } else if (tokenAction === 'update') {
    const token = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would update INSTALLATION_TOKEN');
    } else {
      // F2: Use wranglerSecret wrapper (stdin input, no --value flag)
      const result = wranglerSecret([
        'secrets-store', 'secret', 'update', state.secretsStoreId,
        '--name', 'INSTALLATION_TOKEN',
        '--scopes', 'workers',
      ], token);
      if (result.status !== 0) {
        console.error('Failed to update INSTALLATION_TOKEN');
        process.exit(result.status ?? 1); // F12: propagate status
      }
      console.log('  Updated INSTALLATION_TOKEN');
    }
  } else {
    console.log('  INSTALLATION_TOKEN already set (use --force-secrets to regenerate)');
  }

  // CREDENTIAL_ENCRYPTION_KEY
  const keyAction = computeSecretAction(secrets.credentialEncryptionKey, forceSecrets, dryRun);
  if (keyAction === 'create') {
    const key = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would set CREDENTIAL_ENCRYPTION_KEY');
    } else {
      // F2: Use wranglerSecret wrapper (stdin input, no --value flag)
      const result = wranglerSecret([
        'secrets-store', 'secret', 'create', state.secretsStoreId,
        '--name', 'CREDENTIAL_ENCRYPTION_KEY',
        '--scopes', 'workers',
      ], key);
      if (result.status !== 0) {
        console.error('Failed to set CREDENTIAL_ENCRYPTION_KEY');
        process.exit(result.status ?? 1); // F12: propagate status
      }
      console.log('  Set CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM key per ADR-007)');
      secrets.credentialEncryptionKey = true; // F1: Only flip flag when actually set
    }
  } else if (keyAction === 'update') {
    const key = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would update CREDENTIAL_ENCRYPTION_KEY');
    } else {
      // F2: Use wranglerSecret wrapper (stdin input, no --value flag)
      const result = wranglerSecret([
        'secrets-store', 'secret', 'update', state.secretsStoreId,
        '--name', 'CREDENTIAL_ENCRYPTION_KEY',
        '--scopes', 'workers',
      ], key);
      if (result.status !== 0) {
        console.error('Failed to update CREDENTIAL_ENCRYPTION_KEY');
        process.exit(result.status ?? 1); // F12: propagate status
      }
      console.log('  Updated CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM key per ADR-007)');
    }
  } else {
    console.log('  CREDENTIAL_ENCRYPTION_KEY already set (use --force-secrets to regenerate)');
  }

  return { ...state, secrets };
};

// ---------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------
export const resolveConfigTemplate = (template: string, state: ResourceState): string => {
  let resolved = template;

  // Replace each placeholder with the real ID
  resolved = resolved.replace(
    /"database_id":\s*"REPLACE_WITH_D1_DATABASE_ID"/,
    `"database_id": "${state.d1DatabaseId ?? '<missing>'}"`,
  );
  resolved = resolved.replace(
    /"id":\s*"REPLACE_WITH_KV_SETUP_SESSION_ID"/,
    `"id": "${state.kvSetupSessionId ?? '<missing>'}"`,
  );
  resolved = resolved.replace(
    /"id":\s*"REPLACE_WITH_KV_CACHE_ID"/,
    `"id": "${state.kvCacheId ?? '<missing>'}"`,
  );
  resolved = resolved.replace(
    /"store_id":\s*"REPLACE_WITH_SECRETS_STORE_ID"/g, // Both secrets use the same store
    `"store_id": "${state.secretsStoreId ?? '<missing>'}"`,
  );

  return resolved;
};

const resolveConfig = (state: ResourceState): void => {
  console.log('Generating wrangler.resolved.jsonc…');
  const templatePath = resolve(WORKER_DIR, 'wrangler.jsonc');
  const template = readFileSync(templatePath, 'utf-8');

  const resolved = resolveConfigTemplate(template, state);

  writeFileSync(RESOLVED_CONFIG_PATH, resolved, 'utf-8');
  console.log(`  Wrote ${RESOLVED_CONFIG_PATH}`);
};

// ---------------------------------------------------------------------
// Remote migrations — CAP-039: pending-only
// ---------------------------------------------------------------------
// Reads the remote `d1_migrations` table via `wrangler d1 execute --remote
// --command 'SELECT name FROM d1_migrations ORDER BY name' --json`,
// compares against the on-disk migrations directory, and applies only the
// pending ones. A repeat deploy on a fully-migrated DB is a no-op: the
// script logs `No pending migrations (N already applied).` and exits 0 —
// the same dialect `scripts/db-migrate.ts:124` uses for local, so local
// and remote runners speak the same language.
//
// Wrangler's --json output for a SELECT is the documented batch shape:
//   [{ results: [...], success: true, meta: {...} }]
// On a fresh DB the table doesn't exist; wrangler reports success=false
// with an `error` field, which the ghost-check path turns into an empty
// applied set — no migrations would be "ghost" because applied is empty.

// CAP-039 — pure function that the test suite drives. Given the sorted
// on-disk migration filenames and the sorted applied names from the
// remote `d1_migrations` table, returns:
//   - ghost: applied names that are NOT on disk (a real migration was
//     deleted; the operator must restore it before any further deploy)
//   - pending: on-disk names not yet applied
// Both lists are subsets of the union; no entry is duplicated.
export interface PendingMigrationDecision {
  ghost: string[];
  pending: string[];
}
export const computePendingMigrations = (
  onDisk: readonly string[],
  applied: readonly string[],
): PendingMigrationDecision => {
  const onDiskSet = new Set(onDisk);
  const appliedSet = new Set(applied);
  const ghost: string[] = [];
  for (const a of applied) {
    if (!onDiskSet.has(a)) ghost.push(a);
  }
  const pending: string[] = [];
  for (const f of onDisk) {
    if (!appliedSet.has(f)) pending.push(f);
  }
  return { ghost, pending };
};

// CAP-039 — the no-op log line, exposed so scripts/deploy.test.ts can
// assert local and remote runners share the same dialect (AC #11). The
// string matches `scripts/db-migrate.ts:124` byte-for-byte.
export const NO_PENDING_LOG_FORMAT = 'No pending migrations';

const readRemoteApplied = (): string[] => {
  const r = wrangler([
    'd1', 'execute', 'DB',
    '--config', RESOLVED_CONFIG_PATH,
    '--remote',
    '--command', 'SELECT name FROM d1_migrations ORDER BY name',
    '--json',
  ]);
  if (r.status !== 0) {
    // wrangler reported a non-zero exit; treat as empty so the pending
    // set is everything. The on-disk list itself is the ghost guard.
    return [];
  }
  const parsed = parseWranglerJson(r, 'remote-applied');
  if (!parsed.ok) {
    // Mirror scripts/db-migrate.ts:98-101: a missing `d1_migrations`
    // table on a fresh DB is the expected path — the wrangler batch
    // reports `success: false` with `error: no such table: d1_migrations`,
    // which we treat as an empty applied set so all migrations become
    // pending. Any other parse failure (JSON parse error, missing
    // `results` key on a successful batch) is a hard error and we bail.
    const freshDb = parsed.error.includes('no such table: d1_migrations');
    if (!freshDb) {
      console.error(`Failed to parse remote d1_migrations: ${parsed.error}`);
      process.exit(r.status ?? 1);
    }
    return [];
  }
  return extractColumn(parsed.data, 'name');
};

// CAP-039 D7 — extract the parse discipline so scripts/deploy.test.ts
// can drive it with hand-crafted inputs. Given wrangler's stdout string,
// returns the list of applied migration names (empty array on a
// "no such table: d1_migrations" failure; throws on any other parse
// failure so the caller can decide whether to swallow it).
export const parseAppliedMigrationNames = (raw: string): string[] => {
  const parsed = parseWranglerJson({ status: 0, stdout: raw }, 'remote-applied-test');
  if (parsed.ok) return extractColumn(parsed.data, 'name');
  const freshDb = parsed.error.includes('no such table: d1_migrations');
  if (freshDb) return [];
  throw new Error(parsed.error);
};

const runRemoteMigrations = (): void => {
  console.log('Running remote migrations…');
  if (dryRun) {
    console.log('  [dry-run] Would run remote migrations');
    return;
  }

  if (skipMigrate) {
    console.log('  Skipping migrations (--skip-migrate)');
    return;
  }

  // List migration files (F6: use shared MIGRATION_FILE regex)
  const migrationsDir = resolve(REPO, 'migrations');
  const files = readdirSync(migrationsDir).filter((f: string) => MIGRATION_FILE.test(f)).sort();

  // Read the remote applied set — exit 1 on parse failure (handled inside).
  const applied = readRemoteApplied();

  // Compute the (ghost, pending) split — ghost is a hard error,
  // pending is the work list.
  const { ghost, pending } = computePendingMigrations(files, applied);

  // Ghost check — mirror `scripts/db-migrate.ts:103-110`.
  if (ghost.length > 0) {
    console.error(`Migration file(s) missing from disk but recorded in d1_migrations:`);
    for (const g of ghost) console.error(`  ${g}`);
    console.error(`Refusing to apply. Restore the missing file(s) before re-running.`);
    process.exit(1);
  }

  if (pending.length === 0) {
    // Mirror `scripts/db-migrate.ts:124` so local + remote share the same
    // no-op log line.
    console.log(`No pending migrations (${files.length} already applied).`);
    return;
  }

  for (const file of pending) {
    if (!MIGRATION_FILE.test(file)) {
      console.error(`Refusing migration filename: ${file} (must match /\\d{4}_[A-Za-z0-9_-]+\\.sql\\$/).`);
      process.exit(1);
    }
    console.log(`  Applying ${file}…`);
    const result = wrangler([
      'd1', 'execute', 'DB',
      '--config', RESOLVED_CONFIG_PATH,
      '--remote',
      '--file', resolve(migrationsDir, file),
    ]);
    if (result.status !== 0) {
      console.error(`Failed to apply migration ${file}`);
      process.exit(result.status ?? 1); // F12: propagate wrangler status
    }
  }
  console.log('  Migrations applied.');
};

// ---------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------
const deploy = async (): Promise<void> => {
  console.log('Deploying worker…');
  if (dryRun) {
    console.log('  [dry-run] Would deploy worker');
    return;
  }

  const result = wrangler(['deploy', '--config', RESOLVED_CONFIG_PATH]);
  if (result.status !== 0) {
    console.error(`Deploy failed with exit code ${result.status}`);
    process.exit(result.status ?? 1); // F12: propagate wrangler status
  }

  // Try to extract URL from output
  const urlMatch = result.stdout.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (urlMatch) {
    const url = urlMatch[0];
    console.log(`  Deployed to: ${url}`);

    // Healthz check (F7: add timeout, parse JSON properly)
    console.log('  Running healthz check…');
    try {
      const healthzUrl = `${url}/healthz`;
      const response = await fetch(healthzUrl, { signal: AbortSignal.timeout(10000) }); // 10s timeout
      if (!response.ok) {
        console.error(`  Failed to fetch ${healthzUrl}: status ${response.status}`);
        process.exit(1);
      }
      const body = await response.json() as { ok: boolean };
      if (body.ok !== true) {
        console.error(`  Healthz check failed: response.ok is not true`);
        console.error(`  Response body: ${JSON.stringify(body)}`);
        process.exit(1);
      }
      console.log('  Healthz check passed.');
    } catch (e) {
      console.error(`  Healthz check failed: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.log('  Deployed (could not extract URL for healthz check)');
    console.log('  Note: If workers_dev is false, configure a route or custom domain, then verify manually.');
  }
};

// ---------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------
const main = async (env: string): Promise<void> => {
  console.log(`Deploying unimailbox-worker (ENVIRONMENT=${env})…`);

  // F5: Confirmation prompt for --force-secrets
  if (forceSecrets && !dryRun) {
    console.error('\nWARNING: --force-secrets will overwrite INSTALLATION_TOKEN and CREDENTIAL_ENCRYPTION_KEY.');
    console.error('If CREDENTIAL_ENCRYPTION_KEY is overwritten, all encrypted credentials in the database');
    console.error('will become permanently undecryptable (ADR-007). A re-encryption maintenance job does');
    console.error('not yet exist.\n');
    console.error('Type \'yes\' to continue: ');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
    });

    if (answer !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  checkAuth();

  let state = loadResourceState();

  state = provisionD1(state);
  state = provisionR2(state);
  state = provisionKv(state, 'SETUP_SESSION', 'SETUP_SESSION');
  state = provisionKv(state, 'CACHE', 'CACHE');
  state = provisionQueue(state);
  state = provisionSecretsStore(state);
  state = setSecrets(state);

  // F1: Only save state when not in dry-run mode
  if (!dryRun) {
    saveResourceState(state);
  }

  // Resolve config always (local file write)
  resolveConfig(state);
  runRemoteMigrations();
  await deploy();

  console.log('\nDeploy complete.');
  if (!dryRun) {
    console.log('Resource state saved to:', RESOURCE_STATE_PATH);
  }
  console.log('Resolved config written to:', RESOLVED_CONFIG_PATH);
};

// Only run when executed directly, not when imported by tests
// F11: Use pathToFileURL for correct Windows path handling
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Apply ENVIRONMENT guard before main flow
  const env = process.env.ENVIRONMENT;
  const guardResult = checkEnvironmentGuard(env);
  if (!guardResult.ok) {
    console.error(`Refusing to deploy: ${guardResult.error}`);
    process.exit(2);
  }
  // Guard passed; env is guaranteed to be a non-local string
  const targetEnv = env ?? 'unknown';
  main(targetEnv).catch((e) => {
    console.error('Deploy failed:', e);
    process.exit(1);
  });
}
