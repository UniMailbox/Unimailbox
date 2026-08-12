#!/usr/bin/env node
// scripts/scaffold.ts — dispatcher. Routes subcommands to the right
// script under scripts/. CAP-003 ships `doctor`; CAP-004 adds
// `db:migrate` (with --verify and --reset passthroughs).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUBCOMMAND = process.argv[2];

if (SUBCOMMAND === 'doctor') {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings=ExperimentalWarning',
     fileURLToPath(new URL('./doctor.ts', import.meta.url))],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

if (SUBCOMMAND === 'db:migrate' || SUBCOMMAND === 'db:reset') {
  // Forward the remainder (--verify, --reset, etc.) so the dispatcher
  // stays a thin router. `db:reset` is the same script with --reset
  // prepended; it lets `pnpm scaffold db:reset` exit 2 outside local
  // (F15 / task.md AC #15).
  const forwarded = (
    SUBCOMMAND === 'db:reset' ? ['--reset'] : []
  ).concat(
    [process.argv[3], ...process.argv.slice(4)].filter(
      (v): v is string => typeof v === 'string' && v !== '--reset',
    ),
  );
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings=ExperimentalWarning',
     fileURLToPath(new URL('./db-migrate.ts', import.meta.url)), ...forwarded],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

console.error(`Unknown subcommand: ${SUBCOMMAND ?? '(none)'}`);
console.error('Usage: pnpm scaffold <subcommand>');
console.error('Subcommands:');
console.error('  doctor              — 10 structural checks');
console.error('  db:migrate [--verify|--reset]');
process.exit(1);