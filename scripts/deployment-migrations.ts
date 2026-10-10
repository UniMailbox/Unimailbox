import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  computePendingMigrations,
  parseMigrationVerificationOutput,
} from '#scripts/deployment-parsers';
import {
  requireSuccess,
  type CommandResult,
  type WranglerCommand,
} from '#scripts/deployment-runtime';

export const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;
export function parseRows(result: CommandResult, action: string): Array<Record<string, unknown>> {
  const raw: unknown = JSON.parse(requireSuccess(result, action));
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`${action}: expected a nonempty result batch.`);
  const rows: Array<Record<string, unknown>> = [];
  for (const batch of raw) {
    if (
      !batch ||
      typeof batch !== 'object' ||
      !('success' in batch) ||
      batch.success !== true ||
      !('results' in batch) ||
      !Array.isArray(batch.results)
    ) {
      throw new Error(`${action}: invalid or failed result batch.`);
    }
    for (const row of batch.results) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error(`${action}: invalid row.`);
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}
export function readApplied(wrangler: WranglerCommand): string[] {
  const result = wrangler([
    'd1',
    'execute',
    'DB',
    '--remote',
    '--command',
    'SELECT name FROM d1_migrations ORDER BY name',
    '--json',
  ]);
  return parseAppliedMigrationHistory(result);
}
export function parseAppliedMigrationHistory(
  result: CommandResult,
  action = 'Read remote migration history',
): string[] {
  // A missing tracking table is the only accepted fresh-database response.
  if (
    result.status !== 0 &&
    /\bno such table: d1_migrations\b/.test(`${result.stdout}\n${result.stderr}`)
  )
    return [];
  const rows = parseRows(result, action);
  const names = rows.map((row) => {
    if (typeof row.name !== 'string' || !MIGRATION_FILE.test(row.name))
      throw new Error('Invalid remote migration name.');
    return row.name;
  });
  if (new Set(names).size !== names.length) throw new Error('Duplicate remote migration records.');
  return names;
}
export function readOnlyVerification(source: string): string {
  const sql = source.split('-- BEGIN LOCAL BEHAVIOR CHECKS')[0] ?? '';
  // Legacy companions also exercise fixture writes locally. Remote releases
  // run only their explicitly delimited schema assertions, never those writes.
  if (
    /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH)\b/im.test(
      sql,
    )
  ) {
    throw new Error('Remote migration verification must contain read-only schema assertions.');
  }
  if (!/\bAS\s+assertion\b/i.test(sql) || !/\bAS\s+pass\b/i.test(sql))
    throw new Error('Missing named schema assertions.');
  return sql;
}
export function migrationFiles(repo: string): string[] {
  const files = readdirSync(resolve(repo, 'migrations'))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  if (!files.length) throw new Error('No migrations found.');
  for (const file of files)
    readOnlyVerification(
      readFileSync(resolve(repo, 'migrations', file.replace(/\.sql$/, '.verify.sql')), 'utf8'),
    );
  return files;
}
export function migrationDigests(repo: string): Record<string, string> {
  return Object.fromEntries(
    migrationFiles(repo).map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(resolve(repo, 'migrations', file)))
        .digest('hex'),
    ]),
  );
}
export function migrateAndVerify(
  repo: string,
  wrangler: WranglerCommand,
  verificationDir: string,
): { applied: string[]; verified: string[] } {
  const files = migrationFiles(repo);
  const decision = computePendingMigrations(files, readApplied(wrangler));
  if (decision.ghost.length)
    throw new Error(`Unknown remote migration(s): ${decision.ghost.join(', ')}`);
  for (const file of decision.pending) {
    console.log(`Applying ${file}`);
    requireSuccess(
      wrangler(['d1', 'execute', 'DB', '--remote', '--file', resolve(repo, 'migrations', file)]),
      `Apply ${file}`,
    );
  }
  mkdirSync(verificationDir, { recursive: true });
  // Always verify all applied schema assertions, including on a repeat deploy.
  // Recording applied SQL must never allow a failed verification to disappear.
  for (const file of files) {
    const companion = file.replace(/\.sql$/, '.verify.sql');
    const path = resolve(verificationDir, companion);
    writeFileSync(
      path,
      readOnlyVerification(readFileSync(resolve(repo, 'migrations', companion), 'utf8')),
    );
    console.log(`Verifying ${companion}`);
    // Remote --file uses D1's bulk import endpoint, which returns upload
    // progress and an import summary instead of SELECT assertion rows.
    // Query mode preserves the strict JSON assertion contract.
    const output = requireSuccess(
      wrangler([
        'd1',
        'execute',
        'DB',
        '--remote',
        `--command=${readFileSync(path, 'utf8')}`,
        '--json',
      ]),
      `Verify ${companion}`,
    );
    const verified = parseMigrationVerificationOutput(output, companion);
    if (!verified.ok) throw new Error(verified.error);
  }
  const after = readApplied(wrangler);
  if (files.length !== after.length || files.some((file) => !after.includes(file)))
    throw new Error('Remote migration history changed unexpectedly.');
  return { applied: decision.pending, verified: files };
}
