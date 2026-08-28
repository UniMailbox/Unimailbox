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
const VERIFY_FILE = /^\d{4}_[A-Za-z0-9_-]+\.verify\.sql$/;

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
    // CAP-042 (AC 11): BETTER_AUTH_SECRET is an independent Secrets
    // Store binding (ADR-008 §HTTP and browser session contract). It
    // must never be derived from CREDENTIAL_ENCRYPTION_KEY — the field
    // is a separate resource that this script creates/updates/skips on
    // its own track.
    betterAuthSecret: boolean;
    // CAP-043 Slice 1 / D-CAP-043-D: CURSOR_SIGNING_KEY is the third
    // independent Secrets Store binding (HMAC-SHA-256 cursor signing).
    // Same generation discipline as the other two — fresh 32 random
    // bytes, hex-encoded — but tracked separately so a rotation of one
    // does not silently rotate the others.
    cursorSigningKey: boolean;
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
  const deployEnvironments = ['preview', 'staging', 'production'] as const;
  if (!env || !deployEnvironments.includes(env as (typeof deployEnvironments)[number])) {
    return {
      ok: false,
      error: `ENVIRONMENT=${env ?? '(unset)'} (must be one of ${deployEnvironments.join('|')})`,
    };
  }
  return { ok: true };
};

// ---------------------------------------------------------------------
// Wrangler CLI wrapper (matches db-migrate.ts pattern)
// ---------------------------------------------------------------------
const wrangler = (subargs: string[]): { status: number | null; stdout: string } => {
  // Merge stderr into stdout to avoid interleaving JSON with error messages
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...subargs], {
    cwd: WORKER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  const stdout = result.stdout?.toString('utf-8') ?? '';
  const stderr = result.stderr?.toString('utf-8') ?? '';
  return { status: result.status, stdout: stdout + stderr };
};

// F2: Wrangler wrapper for secret commands (stdin input, no CI flag)
// Secrets are piped via stdin to avoid --value CLI flag visibility.
const wranglerSecret = (
  subargs: string[],
  secret: string,
): { status: number | null; stdout: string } => {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...subargs], {
    cwd: WORKER_DIR,
    input: `${secret}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }, // no CI=1 — let the prompt fire
  });
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

export const saveResourceState = (
  state: ResourceState,
  path: string = RESOURCE_STATE_PATH,
): void => {
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

export function parseWranglerList<T>(
  r: { status: number | null; stdout: string },
  source: string,
): { ok: true; data: T[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    // F4: Include first 200 chars of stdout in parse error for diagnostics
    return {
      ok: false,
      error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `expected JSON array from wrangler, got ${typeof parsed}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  // Current Wrangler list commands return a direct JSON array (for example,
  // `wrangler d1 list --json` returns `[ { uuid, name, ... } ]`). Keep
  // accepting the older `{ success, result }` wrapper used by earlier
  // versions so deploy remains compatible across Wrangler releases.
  if (parsed.length === 0) {
    return { ok: true, data: [] };
  }
  const firstValue = parsed[0];
  if (
    firstValue &&
    typeof firstValue === 'object' &&
    ('success' in firstValue || 'result' in firstValue || 'error' in firstValue)
  ) {
    // First element is the legacy batch wrapper.
    const batch = firstValue as WranglerListResult<T>;
    if (batch.success === false) {
      return {
        ok: false,
        error: `wrangler reported success=false: ${batch.error ?? 'unknown error'}`,
      };
    }
    if (!batch.result || !Array.isArray(batch.result)) {
      return {
        ok: false,
        error: `wrangler batch missing or invalid 'result' field (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}`,
      };
    }
    return { ok: true, data: batch.result };
  }

  if (!parsed.every((value) => value !== null && typeof value === 'object')) {
    return {
      ok: false,
      error: `expected list entries to be objects (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  return { ok: true, data: parsed as T[] };
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
    return {
      ok: false,
      error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `expected JSON array from wrangler, got ${typeof parsed}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  for (const batch of parsed) {
    if (batch && typeof batch === 'object' && (batch as { success?: unknown }).success === false) {
      const err = (batch as { error?: unknown }).error;
      return {
        ok: false,
        error: `wrangler batch reported success=false: ${typeof err === 'string' ? err : JSON.stringify(err)}`,
      };
    }
    if (!batch || typeof batch !== 'object' || !('results' in batch)) {
      return {
        ok: false,
        error: `wrangler batch missing 'results' key (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}`,
      };
    }
  }
  return { ok: true, data: parsed };
}

export interface MigrationVerificationAssertion {
  assertion: string;
  pass: number;
}

export type MigrationVerificationResult =
  | { ok: true; assertions: MigrationVerificationAssertion[] }
  | { ok: false; error: string };

/** Parse and enforce the `{ assertion, pass }` migration companion contract. */
export const parseMigrationVerificationOutput = (
  raw: string,
  source: string,
): MigrationVerificationResult => {
  const parsed = parseWranglerJson({ status: 0, stdout: raw }, source);
  if (!parsed.ok) return parsed;

  const assertions: MigrationVerificationAssertion[] = [];
  for (const batch of parsed.data as Array<{ results: unknown }>) {
    if (!Array.isArray(batch.results)) {
      return { ok: false, error: `${source}: Wrangler batch results must be an array` };
    }
    for (const row of batch.results) {
      if (!row || typeof row !== 'object') continue;
      const hasAssertion = 'assertion' in row;
      const hasPass = 'pass' in row;
      if (!hasAssertion && !hasPass) {
        return {
          ok: false,
          error: `${source}: unexpected non-assertion row ${JSON.stringify(row)}`,
        };
      }
      const candidate = row as { assertion?: unknown; pass?: unknown };
      if (typeof candidate.assertion !== 'string' || typeof candidate.pass !== 'number') {
        return {
          ok: false,
          error: `${source}: malformed assertion row ${JSON.stringify(row)}`,
        };
      }
      assertions.push({ assertion: candidate.assertion, pass: candidate.pass });
    }
  }

  if (assertions.length === 0) {
    return { ok: false, error: `${source}: zero assertion rows returned` };
  }
  const failed = assertions.filter((row) => row.pass !== 1);
  if (failed.length > 0) {
    return {
      ok: false,
      error: `${source}: failed assertion(s): ${failed
        .map((row) => `${row.assertion} (pass=${row.pass})`)
        .join(', ')}`,
    };
  }
  return { ok: true, assertions };
};

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
interface D1Database {
  uuid: string;
  name: string;
}
interface KvNamespace {
  id: string;
  title: string;
}
interface Queue {
  queue_name: string;
}
interface SecretsStore {
  id: string;
  name: string;
}

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
    // Wrangler 4.121 lists R2 buckets as labelled text; older versions may
    // emit JSON. The parser accepts either form and the substring fallback
    // handles the labelled output.
    const listResult = wrangler(['r2', 'bucket', 'list']);
    interface R2Bucket {
      name: string;
    }
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
      console.log(
        '  Bucket already exists: unimailbox-attachments (detected via substring fallback)',
      );
      return { ...state, r2Bucket: 'unimailbox-attachments' };
    }
    console.error(`Failed to create R2 bucket. Exit code: ${result.status}`);
    process.exit(result.status ?? 1); // F12: propagate wrangler status
  }
  console.log('  Created bucket: unimailbox-attachments');
  return { ...state, r2Bucket: 'unimailbox-attachments' };
};

const provisionKv = (
  state: ResourceState,
  binding: 'SETUP_SESSION' | 'CACHE',
  title: string,
): ResourceState => {
  console.log(`Provisioning KV namespace: ${binding}…`);
  const existingId = binding === 'SETUP_SESSION' ? state.kvSetupSessionId : state.kvCacheId;
  if (existingId) {
    console.log(`  Reusing existing KV namespace: ${existingId}`);
    return state;
  }

  // Try to find existing by title
  const listResult = wrangler(['kv', 'namespace', 'list']);
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

  const createResult = wrangler(['kv', 'namespace', 'create', title]);
  if (createResult.status !== 0) {
    console.error(`Failed to create KV namespace. Exit code: ${createResult.status}`);
    process.exit(createResult.status ?? 1);
  }
  // Wrangler 4.121's create command prints only a success line; re-list to
  // retrieve the ID instead of relying on the removed --json flag.
  const afterCreate = parseWranglerList<KvNamespace>(
    wrangler(['kv', 'namespace', 'list']),
    'kv-list-after-create',
  );
  if (!afterCreate.ok) {
    console.error(`Failed to resolve created KV namespace: ${afterCreate.error}`);
    process.exit(1);
  }
  const created = afterCreate.data.find((ns) => ns.title === title);
  if (!created) {
    console.error(`Failed to resolve created KV namespace: title ${title} not found`);
    process.exit(1);
  }
  console.log(`  Created KV namespace: ${created.id}`);
  return binding === 'SETUP_SESSION'
    ? { ...state, kvSetupSessionId: created.id }
    : { ...state, kvCacheId: created.id };
};

const provisionQueue = (state: ResourceState): ResourceState => {
  console.log('Provisioning Queue…');
  if (state.queue) {
    console.log(`  Reusing existing queue: unimailbox-outbound`);
    return state;
  }

  // Try to find existing by name
  const listResult = wrangler(['queues', 'list']);
  const parsed = parseWranglerList<Queue>(listResult, 'queues-list');
  if (parsed.ok) {
    const existing = parsed.data.find((q) => q.queue_name === 'unimailbox-outbound');
    if (existing) {
      console.log('  Found existing queue: unimailbox-outbound');
      return { ...state, queue: 'unimailbox-outbound' };
    }
  } else if (listResult.status === 0 && listResult.stdout.includes('unimailbox-outbound')) {
    // Wrangler 4.121 exposes queues as a human-readable table without a
    // --json option. The queue name is the resource identity, so an exact
    // substring match is sufficient and no ID is needed in config.
    console.log('  Found existing queue: unimailbox-outbound');
    return { ...state, queue: 'unimailbox-outbound' };
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
  const listResult = wrangler(['secrets-store', 'store', 'list', '--remote']);
  const parsed = parseWranglerList<SecretsStore>(listResult, 'secrets-store-list');
  if (parsed.ok) {
    const existing = parsed.data.find((s) => s.name === 'unimailbox-secrets');
    if (existing) {
      console.log(`  Found existing Secrets Store: ${existing.id}`);
      return { ...state, secretsStoreId: existing.id };
    }
  } else if (listResult.status === 0) {
    // Wrangler 4.121 exposes Secrets Store as a table without a --json
    // option. Resolve an exact-name row and its 32-hex store ID.
    const line = listResult.stdout
      .split(/\r?\n/)
      .find((candidate) => candidate.includes('unimailbox-secrets'));
    const id = line?.match(/\b[a-f0-9]{32}\b/i)?.[0];
    if (id) {
      console.log(`  Found existing Secrets Store: ${id}`);
      return { ...state, secretsStoreId: id };
    }
  } else {
    // F4: Parse failures must be visible
    console.error(
      `Warning: could not parse wrangler list output for secrets-store (${parsed.error}).`,
    );
    console.error('Proceeding to create. If the Secrets Store already exists, create will fail.');
    console.error('Delete .cloudflare-resources.json and re-run if needed.');
  }

  if (dryRun) {
    console.log('  [dry-run] Would create Secrets Store: unimailbox-secrets');
    return { ...state, secretsStoreId: '<dry-run-id>' };
  }

  const createResult = wrangler([
    'secrets-store',
    'store',
    'create',
    'unimailbox-secrets',
    '--remote',
  ]);
  if (createResult.status !== 0) {
    console.error(`Failed to create Secrets Store. Exit code: ${createResult.status}`);
    process.exit(createResult.status ?? 1);
  }
  const createdId = createResult.stdout.match(/\bID:\s*([a-f0-9]{32})\b/i)?.[1];
  if (!createdId) {
    console.error('Failed to parse created Secrets Store ID from Wrangler output');
    process.exit(1);
  }
  console.log(`  Created Secrets Store: ${createdId}`);
  return { ...state, secretsStoreId: createdId };
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

  const secrets = state.secrets ?? {
    installationToken: false,
    credentialEncryptionKey: false,
    betterAuthSecret: false,
    cursorSigningKey: false,
  };

  // INSTALLATION_TOKEN
  const tokenAction = computeSecretAction(secrets.installationToken, forceSecrets, dryRun);
  if (tokenAction === 'create') {
    const token = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would set INSTALLATION_TOKEN');
    } else {
      // F2: Use wranglerSecret wrapper (stdin input, no --value flag)
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'create',
          state.secretsStoreId,
          '--name',
          'INSTALLATION_TOKEN',
          '--scopes',
          'workers',
        ],
        token,
      );
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
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'update',
          state.secretsStoreId,
          '--name',
          'INSTALLATION_TOKEN',
          '--scopes',
          'workers',
        ],
        token,
      );
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
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'create',
          state.secretsStoreId,
          '--name',
          'CREDENTIAL_ENCRYPTION_KEY',
          '--scopes',
          'workers',
        ],
        key,
      );
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
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'update',
          state.secretsStoreId,
          '--name',
          'CREDENTIAL_ENCRYPTION_KEY',
          '--scopes',
          'workers',
        ],
        key,
      );
      if (result.status !== 0) {
        console.error('Failed to update CREDENTIAL_ENCRYPTION_KEY');
        process.exit(result.status ?? 1); // F12: propagate status
      }
      console.log('  Updated CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM key per ADR-007)');
    }
  } else {
    console.log('  CREDENTIAL_ENCRYPTION_KEY already set (use --force-secrets to regenerate)');
  }

  // CAP-042 (AC 11): BETTER_AUTH_SECRET is an independent Secrets Store
  // binding — it is NOT a re-encryption of CREDENTIAL_ENCRYPTION_KEY. The
  // two are tracked separately so a rotation of one does not silently
  // rotate the other. A freshly-created secret is 32 random bytes hex
  // (matching the existing `generateSecret()` shape); the secret value is
  // piped through stdin and never echoed in the deploy log.
  const authAction = computeSecretAction(secrets.betterAuthSecret, forceSecrets, dryRun);
  if (authAction === 'create') {
    const value = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would set BETTER_AUTH_SECRET');
    } else {
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'create',
          state.secretsStoreId,
          '--name',
          'BETTER_AUTH_SECRET',
          '--scopes',
          'workers',
        ],
        value,
      );
      if (result.status !== 0) {
        console.error('Failed to set BETTER_AUTH_SECRET');
        process.exit(result.status ?? 1);
      }
      console.log('  Set BETTER_AUTH_SECRET (Better Auth cookie signing key, CAP-042)');
      secrets.betterAuthSecret = true;
    }
  } else if (authAction === 'update') {
    const value = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would update BETTER_AUTH_SECRET');
    } else {
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'update',
          state.secretsStoreId,
          '--name',
          'BETTER_AUTH_SECRET',
          '--scopes',
          'workers',
        ],
        value,
      );
      if (result.status !== 0) {
        console.error('Failed to update BETTER_AUTH_SECRET');
        process.exit(result.status ?? 1);
      }
      console.log('  Updated BETTER_AUTH_SECRET (Better Auth cookie signing key, CAP-042)');
    }
  } else {
    console.log('  BETTER_AUTH_SECRET already set (use --force-secrets to regenerate)');
  }

  // CAP-043 Slice 1 / D-CAP-043-D: CURSOR_SIGNING_KEY is the third
  // independent Secrets Store binding (HMAC-SHA-256 cursor signing).
  // Same generation discipline as the other secrets — fresh 32 random
  // bytes, hex-encoded — but tracked separately so a rotation of one
  // does not silently rotate the others. The deploy log line below
  // names the capability so a reviewer can see the binding they own.
  const cursorAction = computeSecretAction(secrets.cursorSigningKey, forceSecrets, dryRun);
  if (cursorAction === 'create') {
    const value = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would set CURSOR_SIGNING_KEY');
    } else {
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'create',
          state.secretsStoreId,
          '--name',
          'CURSOR_SIGNING_KEY',
          '--scopes',
          'workers',
        ],
        value,
      );
      if (result.status !== 0) {
        console.error('Failed to set CURSOR_SIGNING_KEY');
        process.exit(result.status ?? 1);
      }
      console.log('  Set CURSOR_SIGNING_KEY (cursor HMAC signing key, CAP-043)');
      secrets.cursorSigningKey = true;
    }
  } else if (cursorAction === 'update') {
    const value = generateSecret();
    if (dryRun) {
      console.log('  [dry-run] Would update CURSOR_SIGNING_KEY');
    } else {
      const result = wranglerSecret(
        [
          'secrets-store',
          'secret',
          'update',
          state.secretsStoreId,
          '--name',
          'CURSOR_SIGNING_KEY',
          '--scopes',
          'workers',
        ],
        value,
      );
      if (result.status !== 0) {
        console.error('Failed to update CURSOR_SIGNING_KEY');
        process.exit(result.status ?? 1);
      }
      console.log('  Updated CURSOR_SIGNING_KEY (cursor HMAC signing key, CAP-043)');
    }
  } else {
    console.log('  CURSOR_SIGNING_KEY already set (use --force-secrets to regenerate)');
  }

  return { ...state, secrets };
};

// ---------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------

// CAP-042 (AC 11): deployment-time config guard. The committed
// `wrangler.jsonc` ships with local-friendly defaults (BETTER_AUTH_URL=
// http://localhost, ENVIRONMENT=local). A real deploy target must have
// these values overwritten by the operator; the script refuses to ship
// them as-is. The check is exposed as a pure evaluator so the unit
// suite can drive it without mutating the real config.
export interface DeployConfigGuard {
  ok: boolean;
  error?: string;
}

export const evaluateDeployConfigForTarget = (
  resolved: string,
  targetEnv: string,
): DeployConfigGuard => {
  const deployEnvironments = ['preview', 'staging', 'production'] as const;
  if (
    targetEnv !== 'local' &&
    !deployEnvironments.includes(targetEnv as (typeof deployEnvironments)[number])
  ) {
    return {
      ok: false,
      error: `Unknown deploy target "${targetEnv}"; expected local|${deployEnvironments.join('|')}`,
    };
  }
  // Refuse ENVIRONMENT=local in a non-local deploy.
  const envMatch = resolved.match(/"ENVIRONMENT"\s*:\s*"([^"]+)"/);
  const envValue = envMatch?.[1];
  if (envValue === 'local' && targetEnv !== 'local') {
    return {
      ok: false,
      error: `wrangler.jsonc ENVIRONMENT is "local" but the deploy target is "${targetEnv}"; update ENVIRONMENT and BETTER_AUTH_URL before re-running`,
    };
  }
  if (envValue === undefined && targetEnv !== 'local') {
    return {
      ok: false,
      error: `wrangler.jsonc is missing ENVIRONMENT; the deploy target is "${targetEnv}"`,
    };
  }
  if (targetEnv !== 'local' && envValue !== targetEnv) {
    return {
      ok: false,
      error: `wrangler.jsonc ENVIRONMENT is "${envValue}" but the deploy target is "${targetEnv}"; the values must match exactly`,
    };
  }
  // Refuse BETTER_AUTH_URL=http://localhost in a non-local deploy — Better
  // Auth would sign cookies against a non-routable origin and reject every
  // browser sign-in.
  const urlMatch = resolved.match(/"BETTER_AUTH_URL"\s*:\s*"([^"]+)"/);
  const urlValue = urlMatch?.[1];
  if (typeof urlValue === 'string') {
    if (urlValue === 'http://localhost' && targetEnv !== 'local') {
      return {
        ok: false,
        error: `wrangler.jsonc BETTER_AUTH_URL is "http://localhost" but the deploy target is "${targetEnv}"; replace with the real https origin before re-running`,
      };
    }
    if (urlValue.startsWith('http://') && targetEnv !== 'local') {
      return {
        ok: false,
        error: `wrangler.jsonc BETTER_AUTH_URL is "${urlValue}" (http) but the deploy target is "${targetEnv}"; use https for non-local environments`,
      };
    }
  } else if (targetEnv !== 'local') {
    return {
      ok: false,
      error: `wrangler.jsonc is missing BETTER_AUTH_URL; the deploy target is "${targetEnv}"`,
    };
  }
  return { ok: true };
};

// INV-003 / CAP-005 follow-up: target-value substitution. The deploy flow
// passes the requested target ENVIRONMENT and (when supplied) a
// BETTER_AUTH_URL override into the pure resolver so the gitignored
// generated JSONC reflects the deploy target without mutating the
// committed template. The override is optional — when absent the
// template's local-default sentinel stays in place so the existing
// guard can still fail closed.
export interface ResolveConfigOverrides {
  targetEnv: string;
  betterAuthUrlOverride?: string;
}

export const resolveConfigTemplate = (
  template: string,
  state: ResourceState,
  overrides: ResolveConfigOverrides,
): string => {
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

  // Substitute the target ENVIRONMENT into `vars.ENVIRONMENT`.
  // JSON.stringify produces a JSON-safe encoding so a pathological value
  // (control chars, embedded quotes, backslashes) cannot corrupt the
  // generated JSONC. The guard above will already have rejected any value
  // that is not local|preview|staging|production, but the resolver stays
  // defensive on its own.
  resolved = resolved.replace(
    /"ENVIRONMENT"\s*:\s*"[^"]*"/,
    `"ENVIRONMENT": ${JSON.stringify(overrides.targetEnv)}`,
  );

  // Substitute BETTER_AUTH_URL only when the operator explicitly supplied
  // one. The committed template's local default (`http://localhost`) is the
  // fail-closed sentinel that `evaluateDeployConfigForTarget` relies on for
  // non-local targets; touching it when no override was given would mask
  // operator omission and silently ship a non-routable origin.
  if (overrides.betterAuthUrlOverride !== undefined) {
    resolved = resolved.replace(
      /"BETTER_AUTH_URL"\s*:\s*"[^"]*"/,
      `"BETTER_AUTH_URL": ${JSON.stringify(overrides.betterAuthUrlOverride)}`,
    );
  }

  return resolved;
};

const resolveConfig = (state: ResourceState, targetEnv: string): void => {
  console.log('Generating wrangler.resolved.jsonc…');
  const templatePath = resolve(WORKER_DIR, 'wrangler.jsonc');
  const template = readFileSync(templatePath, 'utf-8');

  // INV-003 / CAP-005 follow-up: pass the target ENVIRONMENT and the
  // operator-supplied BETTER_AUTH_URL (trimmed; absent means no override)
  // into the resolver. The generated JSONC is gitignored — the committed
  // template stays at its local-default sentinel until a deploy target
  // is chosen, and `evaluateDeployConfigForTarget` below still refuses to
  // ship local defaults to a non-local target.
  const rawBetterAuthUrl = process.env.BETTER_AUTH_URL?.trim() ?? '';
  const betterAuthUrlOverride = rawBetterAuthUrl.length > 0 ? rawBetterAuthUrl : undefined;

  // exactOptionalPropertyTypes: omit `betterAuthUrlOverride` when absent
  // rather than passing `undefined` — passing undefined would be rejected
  // by the type checker and would also leak the missing-override intent
  // away from the resolver's own `!== undefined` check.
  const overrides: ResolveConfigOverrides = { targetEnv };
  if (betterAuthUrlOverride !== undefined) {
    overrides.betterAuthUrlOverride = betterAuthUrlOverride;
  }

  const resolved = resolveConfigTemplate(template, state, overrides);

  // CAP-042 (AC 11): refuse to ship local-default config to a non-local
  // target. Better Auth cookies would be signed against a non-routable
  // origin, and ENVIRONMENT=local would skip preflight entirely.
  const guard = evaluateDeployConfigForTarget(resolved, targetEnv);
  if (!guard.ok) {
    console.error(`Refusing to deploy: ${guard.error}`);
    process.exit(1);
  }

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
    'd1',
    'execute',
    'DB',
    '--config',
    RESOLVED_CONFIG_PATH,
    '--remote',
    '--command',
    'SELECT name FROM d1_migrations ORDER BY name',
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
  const directoryEntries = readdirSync(migrationsDir);
  const files = directoryEntries.filter((f: string) => MIGRATION_FILE.test(f)).sort();
  const verifyFiles = new Set(directoryEntries.filter((f: string) => VERIFY_FILE.test(f)));

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

  const invalidCompanions = pending
    .map((file) => file.replace(/\.sql$/, '.verify.sql'))
    .filter((verifyFile) => {
      if (!verifyFiles.has(verifyFile)) return true;
      const source = readFileSync(resolve(migrationsDir, verifyFile), 'utf-8');
      return !/\bAS\s+assertion\b/i.test(source) || !/\bAS\s+pass\b/i.test(source);
    });
  if (invalidCompanions.length > 0) {
    console.error(`Missing or invalid migration companion(s): ${invalidCompanions.join(', ')}`);
    process.exit(1);
  }

  for (const file of pending) {
    if (!MIGRATION_FILE.test(file)) {
      console.error(
        `Refusing migration filename: ${file} (must match /\\d{4}_[A-Za-z0-9_-]+\\.sql\\$/).`,
      );
      process.exit(1);
    }
    console.log(`  Applying ${file}…`);
    const result = wrangler([
      'd1',
      'execute',
      'DB',
      '--config',
      RESOLVED_CONFIG_PATH,
      '--remote',
      '--file',
      resolve(migrationsDir, file),
    ]);
    if (result.status !== 0) {
      console.error(`Failed to apply migration ${file}`);
      process.exit(result.status ?? 1); // F12: propagate wrangler status
    }

    const verifyFile = file.replace(/\.sql$/, '.verify.sql');
    console.log(`  Verifying ${verifyFile}…`);
    const verification = wrangler([
      'd1',
      'execute',
      'DB',
      '--config',
      RESOLVED_CONFIG_PATH,
      '--remote',
      '--file',
      resolve(migrationsDir, verifyFile),
      '--json',
    ]);
    if (verification.status !== 0) {
      console.error(`Failed to execute verification ${verifyFile}`);
      process.exit(verification.status ?? 1);
    }
    const verificationResult = parseMigrationVerificationOutput(verification.stdout, verifyFile);
    if (!verificationResult.ok) {
      console.error(`Migration verification failed: ${verificationResult.error}`);
      process.exit(1);
    }
    console.log(`  ${verifyFile}: ${verificationResult.assertions.length} assertion(s) passed.`);
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
      const body = (await response.json()) as { ok: boolean };
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
    console.log(
      '  Note: If workers_dev is false, configure a route or custom domain, then verify manually.',
    );
  }
};

// ---------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------
const main = async (env: string): Promise<void> => {
  console.log(`Deploying unimailbox-worker (ENVIRONMENT=${env})…`);

  // F5: Confirmation prompt for --force-secrets
  if (forceSecrets && !dryRun) {
    console.error(
      '\nWARNING: --force-secrets will overwrite INSTALLATION_TOKEN, CREDENTIAL_ENCRYPTION_KEY,',
    );
    console.error(
      'BETTER_AUTH_SECRET (CAP-042 / ADR-008), and CURSOR_SIGNING_KEY (CAP-043). The downstream consequences differ per secret:',
    );
    console.error(
      '  - INSTALLATION_TOKEN: ongoing setup sessions are invalidated; new claims are required.',
    );
    console.error(
      '  - CREDENTIAL_ENCRYPTION_KEY: all encrypted credentials in the database will become',
    );
    console.error(
      '    permanently undecryptable (ADR-007). A re-encryption maintenance job does not yet exist.',
    );
    console.error(
      '  - BETTER_AUTH_SECRET: rotating this secret invalidates every existing Better Auth',
    );
    console.error(
      '    session cookie — all logged-in users will be silently signed out (CAP-042 / R-AUTH-004).',
    );
    console.error(
      '  - CURSOR_SIGNING_KEY: rotating this secret invalidates every cursor the client is',
    );
    console.error(
      '    holding (CAP-043 / D-CAP-043-D). Every inbox-list response will need to be re-fetched',
    );
    console.error(
      '    from page 1; pagination forward in progress will land on the next fetch with',
    );
    console.error(
      '    400 INVALID_CURSOR and the inbox will refetch from start (CAP-043 acceptance).',
    );
    console.error("\nType 'yes' to continue: ");

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
  resolveConfig(state, env);
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
