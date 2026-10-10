import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeploymentTarget } from '#scripts/deployment-config';

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type WranglerCommand = (args: readonly string[], input?: string) => CommandResult;
export function requireSuccess(result: CommandResult, action: string): string {
  if (result.status !== 0)
    throw new Error(
      `${action} failed (exit ${result.status ?? 'unknown'}). ${result.stderr.slice(0, 500)}`,
    );
  return result.stdout;
}
export function workspaceWranglerBinary(repo: string): string {
  const workspace = resolve(repo, 'apps/worker');
  const expected = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'))
    .devDependencies.wrangler;
  const installed = JSON.parse(
    readFileSync(resolve(workspace, 'node_modules/wrangler/package.json'), 'utf8'),
  ).version;
  if (installed !== expected)
    throw new Error('Install the frozen lockfile: workspace Wrangler does not match its pin.');
  // The pinned bin wrapper spawns another Node process and can turn a signal
  // exit into status zero. Run its bundled CLI directly so failures propagate.
  return resolve(workspace, 'node_modules/wrangler/wrangler-dist/cli.js');
}
export function isReadOnlyWranglerCommand(args: readonly string[]): boolean {
  const command = args.slice(0, 3).join(' ');
  if (args[0] === 'whoami' || args[0] === '--version') return true;
  if (
    [
      'd1 list --json',
      'kv namespace list',
      'r2 bucket list',
      'queues list',
      'deployments list --json',
    ].includes(command)
  )
    return true;
  if (args[0] === 'secrets-store' && args[2] === 'list') return true;
  if (command === 'd1 time-travel info') return true;
  if (args[0] !== 'd1' || args[1] !== 'execute') return false;
  const sql =
    args.find((arg) => arg.startsWith('--command='))?.slice('--command='.length) ??
    args[args.indexOf('--command') + 1];
  return (
    typeof sql === 'string' &&
    /\bSELECT\b/i.test(sql) &&
    !/(?:^|;)\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH)\b/im.test(
      sql,
    )
  );
}
export function createWrangler(repo: string, target: DeploymentTarget): WranglerCommand {
  const workspace = resolve(repo, 'apps/worker');
  const binary = workspaceWranglerBinary(repo);
  return (args, input) => {
    // Invoke the installed workspace binary directly. pnpm exec can auto-sync
    // dependencies and prepend installation output to otherwise valid JSON.
    for (let attempt = 0; ; attempt++) {
      const r = spawnSync(process.execPath, ['--', binary, ...args, '--config', target.path], {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 300_000,
        input,
        env: {
          ...process.env,
          CI: '1',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_HIDE_BANNER: 'true',
          CLOUDFLARE_ACCOUNT_ID: target.accountId,
        },
      });
      const result = {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr || r.error?.message || '',
      };
      const transportFailure =
        /fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|network connection lost|connectivity issue/i.test(
          `${result.stdout}\n${result.stderr}`,
        );
      if (
        result.status === 0 ||
        attempt >= 2 ||
        !isReadOnlyWranglerCommand(args) ||
        !transportFailure
      )
        return result;
      console.warn(
        `Retrying read-only Cloudflare request (${attempt + 2}/3): ${args.slice(0, 2).join(' ')}`,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * (attempt + 1));
    }
  };
}
export function run(repo: string, executable: string, args: readonly string[]): void {
  const r = spawnSync(executable, args, {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true' },
  });
  if (r.status !== 0)
    throw new Error(`${executable} ${args.join(' ')} failed (exit ${r.status ?? 'unknown'}).`);
}
export function acquireDeployLock(repo: string, target: DeploymentTarget): () => void {
  const dir = resolve(repo, '.tmp/deployment-locks');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${target.accountId}-${target.environment}.lock`);
  const fd = openSync(path, 'wx', 0o600);
  writeFileSync(
    fd,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      worker: target.worker,
    }),
  );
  return () => {
    closeSync(fd);
    unlinkSync(path);
  };
}
export function assertMembership(wrangler: WranglerCommand, target: DeploymentTarget): void {
  const raw: unknown = JSON.parse(
    requireSuccess(wrangler(['whoami', '--json']), 'Cloudflare authentication'),
  );
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('loggedIn' in raw) ||
    raw.loggedIn !== true ||
    !('accounts' in raw) ||
    !Array.isArray(raw.accounts) ||
    !raw.accounts.some(
      (r: unknown) => r && typeof r === 'object' && 'id' in r && r.id === target.accountId,
    )
  ) {
    throw new Error('Authenticated principal is not a member of the selected Cloudflare account.');
  }
}
