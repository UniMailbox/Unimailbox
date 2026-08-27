#!/usr/bin/env node
// scripts/db-migrate.ts — CAP-004 migration runner.
//
// Reads migrations/*.sql in lexicographic order and applies pending
// migrations to the local D1 binding declared in apps/worker/wrangler.jsonc
// via `wrangler d1 execute --file=...`. After applying each migration,
// runs the companion .verify.sql script and exits non-zero if any
// assertion fails.
//
// Tracking uses the `d1_migrations` table, which the schema itself
// creates and inserts a row into in the same D1 batch (F1). The apply
// and the tracking row are therefore atomic at the batch boundary:
// a crash mid-`--file=` rolls back both. See
// migrations/0001_initial.md §Migration tracking convention.
//
// PRAGMA foreign_keys = ON is D1's default on every connection
// (R-DATA-004). The runner does not set it; the first verify assertion
// reads it back to prove the contract holds.
//
// Usage:
//   pnpm scaffold db:migrate            apply pending + verify
//   pnpm scaffold db:migrate --verify   verify only (skip apply)
//   pnpm scaffold db:migrate --reset    drop the local DB, then apply
//
// Environment guard: --reset requires ENVIRONMENT=local (or unset).
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = resolve(REPO, 'migrations');
const WORKER_DIR = resolve(REPO, 'apps/worker');
const PERSIST_DIR = resolve(WORKER_DIR, '.wrangler/state');

const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;
const VERIFY_FILE = /^\d{4}_[A-Za-z0-9_-]+\.verify\.sql$/;

const args = new Set(process.argv.slice(2));
const verifyOnly = args.has('--verify');
const reset = args.has('--reset');

if (reset && process.env.ENVIRONMENT && process.env.ENVIRONMENT !== 'local') {
  console.error(
    `Refusing to reset: ENVIRONMENT=${process.env.ENVIRONMENT} (must be 'local' or unset).`,
  );
  process.exit(2);
}

if (reset) {
  if (statSync(PERSIST_DIR, { throwIfNoEntry: false })) {
    rmSync(PERSIST_DIR, { recursive: true, force: true });
    console.log(`Removed ${PERSIST_DIR}`);
  }
}

const wrangler = (subargs: string[]): { status: number | null; stdout: string } => {
  // Merge stderr into stdout so a wrangler error message that lands on
  // stderr cannot end up interleaved with the --json payload on stdout
  // and confuse the parser. (F2 / code-review H7.)
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...subargs], {
    cwd: WORKER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  const stdout = result.stdout?.toString('utf-8') ?? '';
  const stderr = result.stderr?.toString('utf-8') ?? '';
  return { status: result.status, stdout: stdout + stderr };
};

const all = readdirSync(MIGRATIONS_DIR);
const migrations = all.filter((f) => MIGRATION_FILE.test(f)).sort();
const verifyFiles = new Set(all.filter((f) => VERIFY_FILE.test(f)));
const missingCompanions = migrations
  .map((file) => file.replace(/\.sql$/, '.verify.sql'))
  .filter((file) => !verifyFiles.has(file));
if (missingCompanions.length > 0) {
  console.error(`Missing migration companion(s): ${missingCompanions.join(', ')}`);
  process.exit(1);
}

// F11: every filename that reaches a wrangler --file / --command
// argument must match the strict regex. Defense in depth — readdirSync
// already filtered the list, but a hostile PR or a misconfigured `git
// mv` could reintroduce a dangerous name.
const assertSafeMigrationName = (name: string): void => {
  if (!MIGRATION_FILE.test(name)) {
    console.error(
      `Refusing migration filename: ${name} (must match /\\d{4}_[A-Za-z0-9_-]+\\.sql\\$/).`,
    );
    process.exit(1);
  }
};

// F8: read d1_migrations regardless of --verify / apply. On a fresh
// DB the table doesn't exist yet — `wrangler d1 execute --command` on
// a missing table returns success=false with an `error` field, which
// our JSON shape check turns into an empty applied set. The ghost
// check still runs so a missing-file scenario is caught in both modes.
let applied: string[] = [];
const beforeResult = wrangler([
  'd1',
  'execute',
  'DB',
  '--local',
  '--persist-to',
  PERSIST_DIR,
  '--command',
  'SELECT name FROM d1_migrations ORDER BY name',
  '--json',
]);
const beforeApplied = parseWranglerJson(beforeResult, 'before-applied');
if (beforeApplied.ok) {
  applied = extractColumn(beforeApplied.data, 'name');
}

const onDisk = new Set(migrations);
const ghost = applied.filter((n) => !onDisk.has(n));
if (ghost.length > 0) {
  console.error(`Migration file(s) missing from disk but recorded in d1_migrations:`);
  for (const g of ghost) console.error(`  ${g}`);
  console.error(`Refusing to apply. Restore the missing file(s) before re-running.`);
  process.exit(1);
}

if (!migrations.length) {
  if (verifyOnly) {
    console.error(`No migrations found in ${MIGRATIONS_DIR}.`);
    process.exit(1);
  }
  console.log(`No migrations found in ${MIGRATIONS_DIR}.`);
  process.exit(0);
}

if (!verifyOnly) {
  const pending = migrations.filter((m) => !applied.includes(m));
  if (pending.length === 0) {
    console.log(`No pending migrations (${migrations.length} already applied).`);
  } else {
    for (const file of pending) {
      assertSafeMigrationName(file);
      console.log(`Applying ${file}…`);
      const r = wrangler([
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        PERSIST_DIR,
        '--file',
        resolve(MIGRATIONS_DIR, file),
      ]);
      if (r.status !== 0) {
        console.error(`wrangler d1 execute exited ${r.status} on ${file}.`);
        process.exit(r.status ?? 1);
      }
    }
  }
}

let failed = 0;
let ran = 0;
for (const file of migrations) {
  assertSafeMigrationName(file);
  const verify = file.replace(/\.sql$/, '.verify.sql');
  if (!verifyFiles.has(verify)) {
    console.error(`Missing companion: ${verify}`);
    failed++;
    continue;
  }
  ran++;
  const r = wrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    PERSIST_DIR,
    '--file',
    resolve(MIGRATIONS_DIR, verify),
    '--json',
  ]);
  if (r.status !== 0) {
    console.error(`wrangler d1 execute exited ${r.status} on ${verify}.`);
    failed++;
    continue;
  }
  const parsed = parseWranglerJson(r, verify);
  if (!parsed.ok) {
    console.error(`Could not parse JSON output from ${verify}: ${parsed.error}`);
    failed++;
    continue;
  }
  const assertions = validateAssertionRows(parsed.data, verify);
  if (!assertions.ok) {
    console.error(assertions.error);
    failed++;
  } else {
    console.log(`${verify}: ${assertions.rows.length} assertion(s) passed.`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${ran} verify script(s) reported failures.`);
  process.exit(1);
}
console.log(`\n${ran}/${migrations.length} verify script(s) passed.`);

interface AssertionRow {
  assertion: string;
  pass: number;
}

// F2: wrangler --json shape is documented as an array of batches:
//   [{ results: [...], success: true, meta: {...} }]
// Anything else — single-object shape, streamed JSON, an error object
// from wrangler — fails closed. The runner exits 1 with a non-empty
// error message; the JSON.parse catch path no longer swallows.
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

function validateAssertionRows(
  parsed: unknown,
  source: string,
): { ok: true; rows: AssertionRow[] } | { ok: false; error: string } {
  const rows: AssertionRow[] = [];
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `${source}: expected Wrangler batch array` };
  }
  for (const batch of parsed) {
    if (batch && typeof batch === 'object' && 'results' in batch) {
      const results = (batch as { results: unknown }).results;
      if (!Array.isArray(results)) {
        return { ok: false, error: `${source}: Wrangler batch results must be an array` };
      }
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const hasAssertion = 'assertion' in result;
        const hasPass = 'pass' in result;
        if (!hasAssertion && !hasPass) {
          return {
            ok: false,
            error: `${source}: unexpected non-assertion row ${JSON.stringify(result)}`,
          };
        }
        const row = result as { assertion?: unknown; pass?: unknown };
        if (typeof row.assertion !== 'string' || typeof row.pass !== 'number') {
          return {
            ok: false,
            error: `${source}: malformed assertion row ${JSON.stringify(result)}`,
          };
        }
        rows.push({ assertion: row.assertion, pass: row.pass });
      }
    }
  }
  if (rows.length === 0) {
    return { ok: false, error: `${source}: zero assertion rows returned` };
  }
  const failed = rows.filter((row) => row.pass !== 1);
  if (failed.length > 0) {
    return {
      ok: false,
      error: `${source}: failed assertion(s): ${failed
        .map((row) => `${row.assertion} (pass=${row.pass})`)
        .join(', ')}`,
    };
  }
  return { ok: true, rows };
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
