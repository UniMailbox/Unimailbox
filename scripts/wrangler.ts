#!/usr/bin/env node
// Stable workspace CLI entry: no global fallback or optional network checks.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceWranglerBinary } from '#scripts/deployment-runtime';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  ['--', workspaceWranglerBinary(repo), ...process.argv.slice(2)],
  {
    cwd: resolve(repo, 'apps/worker'),
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true' },
  },
);
process.exitCode = result.status ?? 1;
