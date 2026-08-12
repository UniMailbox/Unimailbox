#!/usr/bin/env node
// scripts/scaffold.ts — CAP-003 dispatcher.
// Routes subcommands to the right script. CAP-003 ships `doctor` only;
// later capabilities add `db:migrate`, etc.
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

console.error(`Unknown subcommand: ${SUBCOMMAND ?? '(none)'}`);
console.error('Usage: pnpm scaffold <subcommand>');
console.error('Subcommands: doctor');
process.exit(1);