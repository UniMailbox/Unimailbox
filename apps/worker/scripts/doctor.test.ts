// apps/worker/scripts/doctor.test.ts — CAP-003 self-test.
// Spawns `pnpm scaffold doctor` and asserts the exit code is 0 on the
// current repo state. Catches regressions to the doctor script's CLI.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../..', import.meta.url).pathname;

describe('pnpm scaffold doctor', () => {
  it('exits 0 on the current repo state', () => {
    const result = spawnSync('pnpm', ['scaffold', 'doctor'], {
      cwd: REPO,
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});