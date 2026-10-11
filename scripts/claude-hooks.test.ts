import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function runGuard(command: string) {
  const scratch = resolve(repository, '.tmp');
  mkdirSync(scratch, { recursive: true });
  // Spaces exercise the same path shape supported by the shared hook settings.
  const fixture = mkdtempSync(resolve(scratch, 'hook test '));
  fixtures.push(fixture);
  cpSync(resolve(repository, '.claude/hooks'), resolve(fixture, '.claude/hooks'), {
    recursive: true,
  });
  const result = spawnSync(
    'bash',
    [resolve(fixture, '.claude/hooks/protect-destructive-commands.sh')],
    { cwd: fixture, input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' },
  );
  const logPath = resolve(fixture, '.tmp/claude-hooks/hooks.log');
  return { result, logPath, log: readFileSync(logPath, 'utf8'), fixture };
}

describe('Claude destructive-command guard privacy', () => {
  it('allows ordinary commands without persisting their credential arguments', () => {
    const privateArgument = randomBytes(24).toString('hex');
    const command = `env FIXTURE_PASSWORD=${privateArgument} pnpm typecheck`;
    const { result, log } = runGuard(command);
    expect(result.status).toBe(0);
    expect(log).toContain('destructive-guard allowed');
    expect(log).not.toContain(command);
    expect(log).not.toContain(privateArgument);
    expect(result.stdout + result.stderr).not.toContain(privateArgument);
  });

  it('rejects destructive commands without echoing or persisting their arguments', () => {
    const privateArgument = randomBytes(24).toString('hex');
    const command = `git reset --hard # ${privateArgument}`;
    const { result, log } = runGuard(command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('BLOCKED by protect-destructive-commands');
    expect(log).toContain('BLOCKED: git reset --hard');
    expect(log).not.toContain(command);
    expect(log).not.toContain(privateArgument);
    expect(result.stdout + result.stderr).not.toContain(privateArgument);
  });

  it('creates private log files even when the parent scratch directory is shared', () => {
    const { result, logPath, fixture } = runGuard('pnpm typecheck');
    expect(result.status).toBe(0);
    expect(statSync(resolve(fixture, '.tmp/claude-hooks')).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });
});
