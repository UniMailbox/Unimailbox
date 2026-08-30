#!/usr/bin/env node
// scripts/scaffold.ts — dispatcher. Routes subcommands to the right
// script under scripts/. CAP-003 ships `doctor`; CAP-004 adds
// `db:migrate` (with --verify and --reset passthroughs); CAP-005 adds
// `deploy`.
//
// Top-level side effects (subcommand dispatch + process.exit) are
// gated behind `pathToFileURL(process.argv[1]).href === import.meta.url`
// so that vitest can import the pure helpers below without invoking
// the dispatcher. This mirrors scripts/deploy.ts (F11 / Windows-path
// safe comparison).
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Compute the argv forwarded to `scripts/db-migrate.ts`. Pure function
 * extracted so the dispatcher's behaviour can be locked with a unit
 * test (see scripts/scaffold.test.ts) instead of relying on a
 * subprocess invocation.
 *
 * Two callers:
 *
 * - `pnpm scaffold db:migrate [argv…]` — pass every flag through.
 *   Critically, `db:migrate --reset` MUST keep `--reset`; otherwise the
 *   runner only verifies and the local D1 persist dir is never wiped.
 * - `pnpm scaffold db:reset [argv…]` — prepend `--reset` ourselves so
 *   the alias works without the operator retyping it, and dedupe in
 *   case the operator also passed `--reset` explicitly.
 */
export function forwardDbMigrateArgs(
  subcommand: string,
  argv: readonly string[],
): readonly string[] {
  if (subcommand === 'db:reset') {
    return ['--reset', ...argv.filter((v) => v !== '--reset')];
  }
  return argv.filter((v): v is string => typeof v === 'string');
}

// Only run the side-effecting dispatcher when executed directly.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const SUBCOMMAND = process.argv[2];

  if (SUBCOMMAND === 'doctor') {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings=ExperimentalWarning',
        fileURLToPath(new URL('./doctor.ts', import.meta.url)),
      ],
      { stdio: 'inherit' },
    );
    process.exit(result.status ?? 1);
  }

  if (SUBCOMMAND === 'db:migrate' || SUBCOMMAND === 'db:reset') {
    // `db:reset` is the same script with --reset prepended; it lets
    // `pnpm scaffold db:reset` exit 2 outside local (F15 / task.md
    // AC #15). Dedup rules live in `forwardDbMigrateArgs`.
    const forwarded = forwardDbMigrateArgs(SUBCOMMAND, process.argv.slice(3));
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings=ExperimentalWarning',
        fileURLToPath(new URL('./db-migrate.ts', import.meta.url)),
        ...forwarded,
      ],
      { stdio: 'inherit' },
    );
    process.exit(result.status ?? 1);
  }

  if (SUBCOMMAND === 'deploy') {
    // CAP-005: Deploy to Cloudflare with automatic resource provisioning.
    // Forwards all args (--force-secrets, --dry-run, --skip-migrate) to deploy.ts.
    const forwarded = [process.argv[3], ...process.argv.slice(4)].filter(
      (v): v is string => typeof v === 'string' && v !== '',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings=ExperimentalWarning',
        fileURLToPath(new URL('./deploy.ts', import.meta.url)),
        ...forwarded,
      ],
      { stdio: 'inherit' },
    );
    process.exit(result.status ?? 1);
  }

  console.error(`Unknown subcommand: ${SUBCOMMAND ?? '(none)'}`);
  console.error('Usage: pnpm scaffold <subcommand>');
  console.error('Subcommands:');
  console.error('  doctor              — 13 structural checks');
  console.error('  db:migrate [--verify|--reset]');
  console.error('  deploy [--force-secrets|--dry-run|--skip-migrate]');
  process.exit(1);
}