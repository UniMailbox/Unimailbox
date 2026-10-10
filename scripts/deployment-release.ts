import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { migrationDigests } from '#scripts/deployment-migrations';
import { run, requireSuccess, type WranglerCommand } from '#scripts/deployment-runtime';
import type { DeploymentTarget } from '#scripts/deployment-config';

export interface ReleaseManifest {
  format: 1;
  environment: string;
  accountId: string;
  worker: string;
  origin: string;
  revision: string;
  tree: string;
  dirty: boolean;
  configDigest: string;
  assetsDigest: string;
  entry: string;
  migrations: Record<string, string>;
  node: string;
  wrangler: string;
  createdAt: string;
  phase: 'prepared' | 'migrating' | 'deploying' | 'verified' | 'failed';
  previousVersion?: string;
  bookmark?: string;
  version?: string;
  applied?: string[];
  verified?: string[];
}
function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Cannot identify release source.');
  return r.stdout;
}
const INPUTS = [
  'migrations',
  'vitest.config.ts',
  'apps',
  'packages',
  'scripts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.nvmrc',
  'eslint.config.js',
  'tsconfig.json',
];
export function sourceIdentity(repo: string): { revision: string; tree: string; dirty: boolean } {
  const files = git(repo, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...INPUTS,
  ])
    .split('\0')
    .filter(Boolean)
    .filter((f) => !/(?:^|\/)(?:dist|node_modules|\.tmp|\.wrangler|\.tsbuildinfo)(?:\/|$)/.test(f))
    .sort();
  const digest = createHash('sha256');
  for (const file of new Set(files)) {
    digest.update(`${file}\0`);
    const path = resolve(repo, file);
    digest.update(existsSync(path) ? readFileSync(path) : '<deleted>');
    digest.update('\0');
  }
  return {
    revision: git(repo, ['rev-parse', 'HEAD']).trim(),
    tree: digest.digest('hex'),
    dirty: git(repo, ['status', '--porcelain', '--', ...INPUTS]).trim().length > 0,
  };
}
export function assetsDigest(root: string): string {
  const digest = createHash('sha256');
  function visit(dir: string): void {
    for (const entry of readdirSync(dir).sort()) {
      const path = resolve(dir, entry);
      if (statSync(path).isDirectory()) visit(path);
      else {
        digest.update(`${relative(root, path)}\0`);
        digest.update(readFileSync(path));
      }
    }
  }
  visit(root);
  return digest.digest('hex');
}
export function saveRelease(path: string, manifest: ReleaseManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
export function prepareRelease(
  repo: string,
  target: DeploymentTarget,
  wrangler: WranglerCommand,
): { path: string; manifest: ReleaseManifest } {
  const initial = sourceIdentity(repo);
  if (target.environment === 'production' && initial.dirty)
    throw new Error('Production requires a clean, committed release source.');
  const pinnedNode = readFileSync(resolve(repo, '.nvmrc'), 'utf8').trim();
  if (process.version !== `v${pinnedNode}`)
    throw new Error(`Use Node ${pinnedNode} before preparing a release.`);
  run(repo, 'pnpm', ['verify']);
  const source = sourceIdentity(repo);
  if (source.tree !== initial.tree)
    throw new Error('Source changed during the release checks. Prepare again.');
  const expectedWrangler = JSON.parse(
    readFileSync(resolve(repo, 'apps/worker/package.json'), 'utf8'),
  ).devDependencies.wrangler as string;
  const actualWrangler = requireSuccess(wrangler(['--version']), 'Read Wrangler version').trim();
  if (actualWrangler !== expectedWrangler)
    throw new Error('Wrangler version differs from the lockfile workspace.');
  const dir = resolve(
    repo,
    '.tmp/releases',
    target.accountId,
    target.environment,
    `${Date.now()}-${source.tree.slice(0, 12)}`,
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  requireSuccess(
    wrangler(['deploy', '--dry-run', '--outdir', resolve(dir, 'bundle')]),
    'Validate environment-specific Worker bundle',
  );
  const html = readFileSync(resolve(repo, 'apps/web/dist/index.html'), 'utf8');
  const entry = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  if (!entry) throw new Error('Build is missing its hashed frontend entry.');
  const manifest: ReleaseManifest = {
    format: 1,
    environment: target.environment,
    accountId: target.accountId,
    worker: target.worker,
    origin: target.origin,
    ...source,
    configDigest: hash(readFileSync(target.path)),
    assetsDigest: assetsDigest(resolve(repo, 'apps/web/dist')),
    entry,
    migrations: migrationDigests(repo),
    node: process.version,
    wrangler: actualWrangler,
    createdAt: new Date().toISOString(),
    phase: 'prepared',
  };
  const path = resolve(dir, 'release.json');
  saveRelease(path, manifest);
  console.log(`Prepared release: ${path}`);
  return { path, manifest };
}
export function loadPreparedRelease(
  repo: string,
  target: DeploymentTarget,
  path: string,
): ReleaseManifest {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
  const source = sourceIdentity(repo);
  if (
    raw.format !== 1 ||
    !['prepared', 'failed'].includes(raw.phase) ||
    raw.environment !== target.environment ||
    raw.accountId !== target.accountId ||
    raw.worker !== target.worker ||
    raw.origin !== target.origin ||
    raw.tree !== source.tree ||
    raw.revision !== source.revision ||
    raw.configDigest !== hash(readFileSync(target.path)) ||
    raw.assetsDigest !== assetsDigest(resolve(repo, 'apps/web/dist'))
  ) {
    throw new Error('Prepared release identity or artifacts changed. Run the checks again.');
  }
  if (target.environment === 'production' && source.dirty)
    throw new Error('Production requires committed source.');
  if (raw.node !== process.version) throw new Error('Node version differs from prepared release.');
  const pinned = JSON.parse(readFileSync(resolve(repo, 'apps/worker/package.json'), 'utf8'))
    .devDependencies.wrangler as string;
  if (raw.wrangler !== pinned) throw new Error('Wrangler version differs from prepared release.');
  return raw;
}
export function activeVersion(wrangler: WranglerCommand, optional = false): string | undefined {
  const r = wrangler(['deployments', 'list', '--json']);
  if (optional && r.status !== 0 && /not found|does not exist/i.test(`${r.stdout}\n${r.stderr}`))
    return undefined;
  const rows = JSON.parse(requireSuccess(r, 'Read deployments')) as Array<{
    created_on: string;
    versions: Array<{ version_id: string; percentage: number }>;
  }>;
  if (!Array.isArray(rows)) throw new Error('Unexpected deployments response.');
  const latest = rows.sort((a, b) => a.created_on.localeCompare(b.created_on)).at(-1);
  if (!latest && optional) return undefined;
  if (!latest || latest.versions.length !== 1 || latest.versions[0]?.percentage !== 100)
    throw new Error('Expected a single active version; refusing to replace a split deployment.');
  return latest.versions[0].version_id;
}
