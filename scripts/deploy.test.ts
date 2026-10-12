import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseJsonc } from './jsonc';
import { parseDeployOptions, publishRelease } from './deploy';
import { assertAccount, assertIsolation, loadTarget } from './deployment-config';
import {
  acquireDeployLock,
  assertMembership,
  createWrangler,
  requireSuccess,
  workspaceWranglerBinary,
  isReadOnlyWranglerCommand,
  type WranglerCommand,
} from './deployment-runtime';
import { migrateAndVerify, readApplied, readOnlyVerification } from './deployment-migrations';
import { parseMigrationVerificationOutput, parseWranglerList } from './deployment-parsers';
import {
  createMissingSecrets,
  parseSecretMetadata,
  provisionSecretStore,
  rotateSecret,
} from './deployment-secrets';
import { ensureResources } from './deployment-resources';
import { smokeRelease } from './deployment-smoke';
import {
  assetsDigest,
  sourceIdentity,
  loadPreparedRelease,
  type ReleaseManifest,
} from './deployment-release';
const repo = resolve(import.meta.dirname, '..');
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'unimailbox-deploy-'));
  dirs.push(dir);
  mkdirSync(resolve(dir, 'apps/worker'), { recursive: true });
  const config = parseJsonc(
    readFileSync(resolve(repo, 'apps/worker/wrangler.staging.jsonc'), 'utf8'),
  ) as {
    vars: Record<string, string>;
    routes: Array<{ pattern: string }>;
    d1_databases: Array<{ database_name: string; database_id: string }>;
    r2_buckets: Array<{ bucket_name: string }>;
    queues: {
      producers: Array<{ queue: string }>;
      consumers: Array<{ queue: string; dead_letter_queue: string }>;
    };
    secrets_store_secrets: Array<{ secret_name: string }>;
  };
  writeFileSync(resolve(dir, 'apps/worker/wrangler.staging.jsonc'), JSON.stringify(config));
  return {
    dir,
    config,
    target: loadTarget(dir, 'staging'),
    save: () =>
      writeFileSync(resolve(dir, 'apps/worker/wrangler.staging.jsonc'), JSON.stringify(config)),
  };
}
const result = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const table = (header: string[], rows: string[][]) =>
  [header, ...rows].map((r) => `│ ${r.join(' │ ')} │`).join('\n');
const secretTable = (target: ReturnType<typeof loadTarget>) =>
  table(
    ['Name', 'ID', 'Comment', 'Scopes', 'Status'],
    target.secrets.map((s, i) => [s.name, String(i + 1).repeat(32), '', 'workers', 'active']),
  );
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function installFakeWrangler(dir: string, source: string): void {
  const workspace = resolve(dir, 'apps/worker');
  const binaryDir = resolve(workspace, 'node_modules/wrangler/wrangler-dist');
  mkdirSync(binaryDir, { recursive: true });
  writeFileSync(
    resolve(workspace, 'package.json'),
    JSON.stringify({ devDependencies: { wrangler: '4.148.0' } }),
  );
  writeFileSync(resolve(binaryDir, '../package.json'), JSON.stringify({ version: '4.148.0' }));
  writeFileSync(resolve(binaryDir, 'cli.js'), source);
}

describe('explicit deployment targets and locks', () => {
  it('rejects missing/ambiguous environments, old bypass flags and encryption rotation', () => {
    for (const argv of [
      [],
      ['--environment', 'local'],
      ['--environment', 'staging', '--force-secrets'],
      ['--environment', 'staging', '--skip-migrate'],
      ['--environment', 'staging', '--secret', 'CREDENTIAL_ENCRYPTION_KEY'],
    ])
      expect(() => parseDeployOptions(argv, undefined)).toThrow();
    expect(parseDeployOptions(['--environment', 'staging', '--dry-run'], undefined)).toMatchObject({
      environment: 'staging',
      dryRun: true,
    });
    expect(() => parseDeployOptions(['--environment', 'staging'], 'production')).toThrow(
      'conflicts',
    );
  });
  it('requires a canonical environment config and matching origin/account/worker', () => {
    const f = fixture();
    expect(() => loadTarget(f.dir, 'production')).toThrow('Configure');
    expect(() => assertAccount(f.target, '0'.repeat(32))).toThrow('conflicts');
    f.config.vars.APP_ORIGIN = 'https://wrong.example.com';
    f.save();
    expect(() => loadTarget(f.dir, 'staging')).toThrow('custom domain');
  });
  it('rejects shared resources across environments', () => {
    const f = fixture();
    const prod = JSON.parse(JSON.stringify(f.config));
    prod.name = 'unimailbox-production';
    prod.vars.ENVIRONMENT = 'production';
    prod.vars.APP_ORIGIN = 'https://mail.example.com';
    prod.routes[0].pattern = 'mail.example.com';
    prod.d1_databases[0].database_name = 'unimailbox-production-db';
    prod.r2_buckets[0].bucket_name = 'unimailbox-production-attachments';
    prod.queues.producers.forEach(
      (p: { queue: string }) => (p.queue = p.queue.replace('staging', 'production')),
    );
    prod.queues.consumers[0].queue = 'unimailbox-production-outbound';
    prod.queues.consumers[0].dead_letter_queue = 'unimailbox-production-outbound-dlq';
    prod.secrets_store_secrets.forEach(
      (p: { secret_name: string }) =>
        (p.secret_name = p.secret_name.replace('staging', 'production')),
    );
    writeFileSync(resolve(f.dir, 'apps/worker/wrangler.production.jsonc'), JSON.stringify(prod));
    expect(() => assertIsolation(f.dir, f.target)).toThrow('shared');
  });
  it('refuses an unverified account membership and concurrent deploys', () => {
    const f = fixture();
    expect(() =>
      assertMembership(() => result({ loggedIn: true, accounts: [] }), f.target),
    ).toThrow('member');
    const release = acquireDeployLock(f.dir, f.target);
    expect(() => acquireDeployLock(f.dir, f.target)).toThrow();
    release();
    acquireDeployLock(f.dir, f.target)();
  });
  it('executes only the pinned workspace binary without package-manager stdout', () => {
    const f = fixture();
    installFakeWrangler(
      f.dir,
      'console.log(JSON.stringify({args:process.argv.slice(2),account:process.env.CLOUDFLARE_ACCOUNT_ID}));',
    );
    const result = createWrangler(f.dir, f.target)(['whoami', '--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['whoami', '--json', '--config', f.target.path],
      account: f.target.accountId,
    });
    writeFileSync(workspaceWranglerBinary(f.dir), 'process.kill(process.pid, "SIGTERM");');
    expect(() => requireSuccess(createWrangler(f.dir, f.target)(['--version']), 'CLI')).toThrow(
      'failed',
    );
    writeFileSync(
      resolve(f.dir, 'apps/worker/node_modules/wrangler/package.json'),
      '{"version":"other"}',
    );
    expect(() => workspaceWranglerBinary(f.dir)).toThrow('pin');
  });
  it('retries transport failures only for read-only commands and never replays writes', () => {
    const f = fixture();
    const counter = resolve(f.dir, 'attempts.txt');
    installFakeWrangler(
      f.dir,
      `const fs=require('node:fs');const p=${JSON.stringify(counter)};let n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));if(n===0){console.error('fetch failed');process.exit(1)}console.log('[]');`,
    );
    expect(createWrangler(f.dir, f.target)(['d1', 'list', '--json']).status).toBe(0);
    expect(readFileSync(counter, 'utf8')).toBe('2');
    writeFileSync(counter, '0');
    expect(createWrangler(f.dir, f.target)(['deploy']).status).toBe(1);
    expect(readFileSync(counter, 'utf8')).toBe('1');
    for (const args of [
      ['d1', 'execute', 'DB', '--file', 'schema.sql'],
      ['secrets-store', 'secret', 'update'],
      ['queues', 'create', 'queue'],
    ])
      expect(isReadOnlyWranglerCommand(args)).toBe(false);
  });
});
describe('migration failures block releases', () => {
  it('never treats a failed history read as an empty database', () => {
    for (const response of [
      { status: 1, stdout: '', stderr: 'authentication failed' },
      result({}),
      result([{ success: false, results: [] }]),
      { status: 0, stdout: 'bad json', stderr: '' },
    ])
      expect(() => readApplied(() => response)).toThrow();
    expect(
      readApplied(() => ({ status: 1, stdout: '', stderr: 'no such table: d1_migrations' })),
    ).toEqual([]);
  });
  it('rechecks an already applied migration after a failed assertion on every attempt', () => {
    const f = fixture();
    mkdirSync(resolve(f.dir, 'migrations'));
    writeFileSync(resolve(f.dir, 'migrations/0001_test.sql'), '-- already applied');
    writeFileSync(
      resolve(f.dir, 'migrations/0001_test.verify.sql'),
      "SELECT 'exists' AS assertion, 1 AS pass;",
    );
    const command = vi.fn<WranglerCommand>((args) =>
      result([
        {
          success: true,
          results: args.includes('SELECT name FROM d1_migrations ORDER BY name')
            ? [{ name: '0001_test.sql' }]
            : [{ assertion: 'exists', pass: 0 }],
        },
      ]),
    );
    for (let i = 0; i < 2; i++)
      expect(() => migrateAndVerify(f.dir, command, resolve(f.dir, 'verify'))).toThrow(
        'failed assertion',
      );
    expect(
      command.mock.calls.filter(([args]) => args.some((arg) => arg.includes('AS assertion'))),
    ).toHaveLength(2);
    expect(command.mock.calls.some(([args]) => args.includes('--file'))).toBe(false);
    expect(
      command.mock.calls
        .filter(([args]) => args.some((arg) => arg.includes('AS assertion')))
        .every(([args]) => args.some((arg) => arg.startsWith('--command='))),
    ).toBe(true);
  });
  it('separates local fixture writes from remote read-only assertions', () => {
    expect(
      readOnlyVerification(
        "SELECT 'schema' AS assertion, 1 AS pass;\n-- BEGIN LOCAL BEHAVIOR CHECKS\nDELETE FROM users;",
      ),
    ).not.toContain('DELETE');
    expect(() =>
      readOnlyVerification("SELECT 'schema' AS assertion, 1 AS pass;\nDELETE FROM users;"),
    ).toThrow('read-only');
    expect(() =>
      readOnlyVerification("SELECT 'schema' AS assertion, 1 AS pass; DELETE FROM users;"),
    ).toThrow('read-only');
  });
  it('rejects nonzero CLI exit, failed batches and malformed verification', () => {
    expect(parseWranglerList({ status: 1, stdout: '[]' }, 'list').ok).toBe(false);
    for (const raw of [
      '[]',
      '{}',
      '[{"results":[]}]',
      '[{"success":false,"results":[]}]',
      '[{"success":true,"results":[{"assertion":"schema","pass":0}]}]',
      '[{"success":true,"results":[{"Total queries executed":1}]}]',
      '├ Checking if file needs uploading\n│ 🌀 Uploading complete.\n[{"success":true,"results":[{"assertion":"schema","pass":1}]}]',
    ])
      expect(parseMigrationVerificationOutput(raw, 'schema').ok).toBe(false);
    expect(
      parseMigrationVerificationOutput(
        JSON.stringify([{ success: true, results: [{ assertion: 'schema', pass: 1 }] }]),
        'schema',
      ).ok,
    ).toBe(true);
  });
});
describe('remote secret and resource operations', () => {
  it('preserves existing secrets and rotates exactly the named key via --secret-id', () => {
    const f = fixture();
    const commands = vi.fn<WranglerCommand>((args) =>
      args.includes('list') ? { status: 0, stdout: secretTable(f.target), stderr: '' } : result({}),
    );
    createMissingSecrets(f.dir, commands, f.target);
    expect(
      commands.mock.calls.every(([args]) => args.includes('--remote') && args.includes('list')),
    ).toBe(true);
    rotateSecret(f.dir, commands, f.target, 'INSTALLATION_TOKEN');
    const update = commands.mock.calls.find(([args]) => args.includes('update'));
    expect(update?.[0]).toContain('--secret-id');
    expect(update?.[0]).toContain('--remote');
    expect(update?.[0]).not.toContain('--name');
    const before = commands.mock.calls.length;
    expect(() => rotateSecret(f.dir, commands, f.target, 'CREDENTIAL_ENCRYPTION_KEY')).toThrow(
      're-encryption',
    );
    expect(commands).toHaveBeenCalledTimes(before);
  });
  it('creates absent secrets remotely, accepting only the CLI exact empty response', () => {
    const f = fixture();
    const created = new Set<string>();
    const commands = vi.fn<WranglerCommand>((args, input) => {
      if (args.includes('create')) {
        expect(args).toContain('--remote');
        expect(input).toMatch(/^[a-f0-9]{64}\n$/);
        created.add(String(args[args.indexOf('--name') + 1]));
        return result({});
      }
      if (!created.size)
        return { status: 1, stdout: '', stderr: 'List request returned no secrets.' };
      return {
        status: 0,
        stdout: table(
          ['Name', 'ID', 'Comment', 'Scopes', 'Status'],
          [...created].map((name, i) => [name, String(i + 1).repeat(32), '', 'workers', 'active']),
        ),
        stderr: '',
      };
    });
    createMissingSecrets(f.dir, commands, f.target);
    expect(created.size).toBe(3);
    expect(parseSecretMetadata(secretTable(f.target))).toHaveLength(3);
  });
  it('waits for a newly created secret to become visible and active without recreating it', () => {
    const f = fixture();
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    let created = false;
    let confirmationReads = 0;
    const commands = vi.fn<WranglerCommand>((args) => {
      if (args.includes('create')) {
        created = true;
        return result({});
      }
      const read = created ? ++confirmationReads : 0;
      const rows = f.target.secrets.flatMap((s, i) => {
        if (i === 0 && read < 2) return [];
        return [
          [
            s.name,
            String(i + 1).repeat(32),
            '',
            'workers',
            read === 2 && i === 0 ? 'pending' : 'active',
          ],
        ];
      });
      return {
        status: 0,
        stdout: table(['Name', 'ID', 'Comment', 'Scopes', 'Status'], rows),
        stderr: '',
      };
    });
    createMissingSecrets(f.dir, commands, f.target);
    expect(commands.mock.calls.filter(([args]) => args.includes('create'))).toHaveLength(1);
    expect(commands.mock.calls.some(([args]) => args.includes('update'))).toBe(false);
    expect(Atomics.wait).toHaveBeenCalledTimes(2);
  });
  it('stops after bounded confirmation reads if a created secret never becomes active', () => {
    const f = fixture();
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const commands = vi.fn<WranglerCommand>((args) =>
      args.includes('create')
        ? result({})
        : {
            status: 0,
            stdout: table(
              ['Name', 'ID', 'Comment', 'Scopes', 'Status'],
              f.target.secrets
                .slice(1)
                .map((s, i) => [s.name, String(i + 2).repeat(32), '', 'workers', 'active']),
            ),
            stderr: '',
          },
    );
    expect(() => createMissingSecrets(f.dir, commands, f.target)).toThrow(
      'Cannot confirm created remote secret',
    );
    expect(commands.mock.calls.filter(([args]) => args.includes('create'))).toHaveLength(1);
    expect(commands.mock.calls.filter(([args]) => args.includes('list'))).toHaveLength(4);
    expect(Atomics.wait).toHaveBeenCalledTimes(2);
  });
  it('reuses the existing account store without requiring a hard-coded store name', () => {
    const f = fixture();
    f.target.secrets.forEach((s) => (s.storeId = 'PROVISION'));
    const commands = vi.fn<WranglerCommand>(() => ({
      status: 0,
      stdout: table(['Name', 'ID'], [['default_secrets_store', 'a'.repeat(32)]]),
      stderr: '',
    }));
    provisionSecretStore(commands, f.target);
    expect(commands).toHaveBeenCalledTimes(1);
    expect(f.target.secrets.every((s) => s.storeId === 'a'.repeat(32))).toBe(true);
  });
  it('resolves D1 from a fresh list after create instead of parsing JSONC output', () => {
    const f = fixture();
    f.target.database.id = 'PROVISION';
    let created = false;
    const commands = vi.fn<WranglerCommand>((args) => {
      if (args[0] === 'd1' && args[1] === 'create') {
        created = true;
        return { status: 0, stdout: '"d1_databases": [{ "database_id": "..." }]', stderr: '' };
      }
      if (args[0] === 'd1')
        return result(
          created
            ? [{ uuid: f.config.d1_databases[0].database_id, name: f.target.database.name }]
            : [],
        );
      if (args[0] === 'kv') return result(f.target.namespaces.map((n) => ({ id: n.id })));
      if (args[0] === 'r2') return { status: 0, stdout: `name: ${f.target.bucket}\n`, stderr: '' };
      return {
        status: 0,
        stdout: table(['name'], [[f.target.queue], [f.target.deadLetterQueue]]),
        stderr: '',
      };
    });
    ensureResources(commands, f.target, true);
    expect(created).toBe(true);
  });
});
describe('custom domain smoke', () => {
  it('checks actual assets, auth, security headers and missing paths', async () => {
    const manifest = {
      origin: 'https://staging.example.com',
      version: 'version',
      tree: 'tree',
      entry: '/assets/index-123.js',
      migrations: { '0031_test.sql': 'hash' },
    } as ReleaseManifest;
    const paths: string[] = [];
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === '/healthz')
        return Response.json({ ok: true, version: 'version', tree: 'tree' });
      if (url.pathname === '/readyz') return Response.json({ ok: true, schema: '0031' });
      if (url.pathname === '/api/v1/setup/status')
        return Response.json({ data: { status: 'complete' } });
      if (url.pathname === '/login')
        return new Response(manifest.entry, {
          headers: { 'Content-Security-Policy': "default-src 'self'" },
        });
      if (url.pathname === manifest.entry)
        return new Response('js', {
          headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, immutable' },
        });
      if (url.pathname === '/api/v1/admin/overview')
        return Response.json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, { status: 401 });
      return new Response(null, { status: 404 });
    });
    await smokeRelease(manifest, request);
    expect(paths).toContain('/api');
    expect(paths).toContain('/assets/deploy-smoke-missing.js');
    await expect(smokeRelease({ ...manifest, version: 'wrong' }, request)).rejects.toThrow(
      'version',
    );
  });
  it('checks the fresh installation page and refuses an unguarded admin API', async () => {
    const manifest = {
      origin: 'https://production.example.com',
      version: 'version',
      tree: 'tree',
      entry: '/assets/index-123.js',
      migrations: { '0033_test.sql': 'hash' },
    } as ReleaseManifest;
    let guarded = true;
    let setupStatus = 'setup';
    const request = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/healthz') return Response.json({ ok: true, version: 'version', tree: 'tree' });
      if (path === '/readyz') return Response.json({ ok: true, schema: '0033' });
      if (path === '/api/v1/setup/status') return Response.json({ data: { status: setupStatus } });
      if (path === '/setup')
        return new Response(manifest.entry, {
          headers: { 'Content-Security-Policy': "default-src 'self'" },
        });
      if (path === manifest.entry)
        return new Response('js', {
          headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, immutable' },
        });
      if (path === '/api/v1/admin/overview')
        return guarded
          ? new Response(null, { status: 302, headers: { Location: '/setup' } })
          : Response.json({ data: {} });
      return new Response(null, { status: 404 });
    });
    await smokeRelease(manifest, request);
    guarded = false;
    await expect(smokeRelease(manifest, request)).rejects.toThrow('setup gate');
    setupStatus = 'unknown';
    await expect(smokeRelease(manifest, request)).rejects.toThrow('Installation status');
  });
});

describe('prepared release identity', () => {
  it('rejects changed assets and source after successful preparation', () => {
    const f = fixture();
    writeFileSync(
      resolve(f.dir, 'apps/worker/package.json'),
      JSON.stringify({ devDependencies: { wrangler: '4.148.0' } }),
    );
    mkdirSync(resolve(f.dir, 'apps/web/dist'), { recursive: true });
    writeFileSync(resolve(f.dir, '.gitignore'), 'apps/web/dist\n');
    writeFileSync(resolve(f.dir, 'apps/web/dist/index.html'), 'prepared');
    for (const args of [
      ['init', '--quiet'],
      ['add', '.'],
      [
        '-c',
        'user.name=Deployment Test',
        '-c',
        'user.email=deployment-test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ],
    ]) {
      expect(spawnSync('git', args, { cwd: f.dir }).status).toBe(0);
    }
    const manifest = {
      format: 1,
      environment: 'staging',
      accountId: f.target.accountId,
      worker: f.target.worker,
      origin: f.target.origin,
      ...sourceIdentity(f.dir),
      configDigest: createHash('sha256').update(readFileSync(f.target.path)).digest('hex'),
      assetsDigest: assetsDigest(resolve(f.dir, 'apps/web/dist')),
      node: process.version,
      wrangler: '4.148.0',
      phase: 'prepared',
    };
    const path = resolve(f.dir, 'release.json');
    writeFileSync(path, JSON.stringify(manifest));
    expect(loadPreparedRelease(f.dir, f.target, path).phase).toBe('prepared');
    writeFileSync(resolve(f.dir, 'apps/web/dist/index.html'), 'stale changed build');
    expect(() => loadPreparedRelease(f.dir, f.target, path)).toThrow('changed');
    writeFileSync(resolve(f.dir, 'apps/web/dist/index.html'), 'prepared');
    writeFileSync(resolve(f.dir, 'apps/worker/new-source.ts'), '// edit after checks');
    expect(() => loadPreparedRelease(f.dir, f.target, path)).toThrow('changed');
  });
});

describe('release orchestration fail closed', () => {
  it('never invokes deploy after a remote history read failure', async () => {
    const f = fixture();
    mkdirSync(resolve(f.dir, 'migrations'));
    writeFileSync(resolve(f.dir, 'migrations/0001_test.sql'), '-- fixture');
    writeFileSync(
      resolve(f.dir, 'migrations/0001_test.verify.sql'),
      "SELECT 'schema' AS assertion, 1 AS pass;",
    );
    const commands = vi.fn<WranglerCommand>((args) => {
      if (args[0] === 'whoami')
        return result({ loggedIn: true, accounts: [{ id: f.target.accountId }] });
      if (args[0] === 'd1' && args[1] === 'list')
        return result([{ name: f.target.database.name, uuid: f.target.database.id }]);
      if (args[0] === 'kv') return result(f.target.namespaces);
      if (args[0] === 'r2') return { status: 0, stdout: `name: ${f.target.bucket}\n`, stderr: '' };
      if (args[0] === 'queues')
        return {
          status: 0,
          stdout: table(['name'], [[f.target.queue], [f.target.deadLetterQueue]]),
          stderr: '',
        };
      if (args[0] === 'secrets-store')
        return { status: 0, stdout: secretTable(f.target), stderr: '' };
      if (args[0] === 'deployments')
        return result([
          { created_on: '2026-10-08', versions: [{ version_id: 'previous', percentage: 100 }] },
        ]);
      if (args[1] === 'time-travel') return result({ bookmark: 'bookmark' });
      return { status: 1, stdout: '', stderr: 'remote read failed' };
    });
    const path = resolve(f.dir, 'release.json');
    const manifest = { phase: 'prepared' } as ReleaseManifest;
    const smoke = vi.fn();
    await expect(publishRelease(f.dir, f.target, path, manifest, commands, smoke)).rejects.toThrow(
      'Read remote migration history',
    );
    expect(commands.mock.calls.some(([args]) => args[0] === 'deploy')).toBe(false);
    expect(commands.mock.calls.some(([args]) => args.includes('--file'))).toBe(false);
    expect(smoke).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, 'utf8')).phase).toBe('failed');
  });
});

describe('local migration CLI', () => {
  it.each(['malformed', 'network', 'failed-batch'])(
    'aborts before SQL when the history response is %s',
    (mode) => {
      const f = fixture();
      const calls = resolve(f.dir, 'calls.txt');
      installFakeWrangler(
        f.dir,
        `
const fs = require('node:fs');fs.appendFileSync(process.env.DEPLOY_TEST_CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.env.DEPLOY_TEST_MODE==='network'){console.error('connection failed');process.exit(1);}
console.log(process.env.DEPLOY_TEST_MODE==='malformed'?'not json':'[{"success":false,"results":[]}]');
`,
      );
      mkdirSync(resolve(f.dir, 'scripts'));
      mkdirSync(resolve(f.dir, 'migrations'));
      writeFileSync(
        resolve(f.dir, 'package.json'),
        JSON.stringify({ type: 'module', imports: { '#scripts/*': './scripts/*.ts' } }),
      );
      for (const file of [
        'db-migrate.ts',
        'deployment-migrations.ts',
        'deployment-runtime.ts',
        'deployment-parsers.ts',
      ])
        writeFileSync(
          resolve(f.dir, 'scripts', file),
          readFileSync(resolve(repo, 'scripts', file)),
        );
      const run = spawnSync(
        process.execPath,
        ['--experimental-strip-types', resolve(f.dir, 'scripts/db-migrate.ts')],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            DEPLOY_TEST_CALLS: calls,
            DEPLOY_TEST_MODE: mode,
            ENVIRONMENT: 'local',
          },
          timeout: 10000,
        },
      );
      expect(run.status).toBe(1);
      const invocations = readFileSync(calls, 'utf8').trim().split('\n');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain('SELECT name FROM d1_migrations');
    },
  );
});
