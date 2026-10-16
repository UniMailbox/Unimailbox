#!/usr/bin/env node
// scripts/doctor.ts — CAP-003. Exits 0 if all 13 structural checks pass.
// See work/active/CAP-003-scaffold-doctor/task.md. Doctor reports; does
// not fix. No remote calls, no imports from apps/worker/src/*.
//
// CAP-039 adds three new checks for the deployment substrate:
//   - web-assets-binding — apps/worker/wrangler.jsonc declares an `assets`
//     block whose directory resolves to apps/web/dist/.
//   - queue-consumer-topology — every queue in queues.producers[] has a
//     matching entry in queues.consumers[] and vice versa, with
//     max_retries present.
//   - migration-strategy-pending-only — wrangler.jsonc.d1_databases[].migrations_dir
//     is unset and no top-level apply_migrations is set; the pending-only
//     deploy path is the authority.
//
// The three new checks expose pure evaluators (evaluateWebAssetsBinding,
// evaluateQueueConsumerTopology, evaluateMigrationStrategyPendingOnly) so
// scripts/doctor.test.ts can drive them against synthetic wrangler.jsonc
// fixtures without mutating the repo's real config files.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonc } from '#scripts/jsonc';
export { parseJsonc } from '#scripts/jsonc';

const REPO = resolve(new URL('..', import.meta.url).pathname);
export type R = { name: string; ok: boolean; detail?: string };
type Ck = () => Promise<R>;

function readJsonc(p: string): unknown {
  return parseJsonc(readFileSync(p, 'utf-8'));
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf-8')) as T;
}
function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    out.push(...(statSync(p).isDirectory() ? walk(p) : [p]));
  }
  return out;
}

// CAP-001 + CAP-042 — the canonical binding/var name set. The same
// names must appear in `apps/worker/wrangler.jsonc`,
// `apps/worker/wrangler.test.jsonc`, AND the `Env` type in
// `apps/worker/src/platform/env.ts`. Any drift between the three
// surfaces means the worker-pool tests cannot exercise the same
// bindings the deployed Worker reads — a class of bug the unit suite
// alone will not catch.
//
// Application-owned authentication has no Better Auth or Cloudflare Access
// binding. The pre-existing installation and credential secrets stay.
const BINDS = [
  'DB',
  'ATTACHMENTS',
  'SETUP_SESSION',
  'CACHE',
  'OUTBOUND',
  'ASSETS',
  'INSTALLATION_TOKEN',
  'CREDENTIAL_ENCRYPTION_KEY',
  'ENVIRONMENT',
];

function extractBindingNames(cfg: Record<string, unknown>): Set<string> {
  const have = new Set<string>();
  for (const x of (cfg['d1_databases'] as Array<{ binding: string }> | undefined) ?? [])
    have.add(x.binding);
  for (const x of (cfg['r2_buckets'] as Array<{ binding: string }> | undefined) ?? [])
    have.add(x.binding);
  for (const x of (cfg['kv_namespaces'] as Array<{ binding: string }> | undefined) ?? [])
    have.add(x.binding);
  for (const x of (cfg['queues'] as { producers?: Array<{ binding: string }> } | undefined)
    ?.producers ?? [])
    have.add(x.binding);
  for (const x of (cfg['secrets_store_secrets'] as Array<{ binding: string }> | undefined) ?? [])
    have.add(x.binding);
  // `assets` block produces a Fetcher binding; the schema permits either
  // a single object or an array of objects in wrangler 4.x.
  const assets = cfg['assets'];
  if (Array.isArray(assets)) {
    for (const a of assets) {
      if (a && typeof a === 'object' && 'binding' in a)
        have.add((a as { binding: string }).binding);
    }
  } else if (assets && typeof assets === 'object' && 'binding' in assets) {
    have.add((assets as { binding: string }).binding);
  }
  for (const k of Object.keys((cfg['vars'] as Record<string, unknown> | undefined) ?? {}))
    have.add(k);
  return have;
}

// CAP-042 (AC 11): cross-surface parity check. The check
// `wrangler-bindings` runs as a single doctor entry but reports the
// three pairwise diffs as one combined detail. The pure evaluator
// `evaluateWranglerBindings` is exported so `apps/worker/scripts/
// doctor.test.ts` can drive it with synthetic fixtures without
// mutating the real config files.
export function evaluateWranglerBindings(
  prod: Record<string, unknown>,
  test: Record<string, unknown>,
  envKeys: ReadonlySet<string>,
): R {
  const prodNames = extractBindingNames(prod);
  const testNames = extractBindingNames(test);
  const missingProd = BINDS.filter((n) => !prodNames.has(n));
  const missingTest = BINDS.filter((n) => !testNames.has(n));
  const missingEnv = BINDS.filter((n) => !envKeys.has(n));
  const bad: string[] = [];
  if (missingProd.length) bad.push(`wrangler.jsonc missing: ${missingProd.join(', ')}`);
  if (missingTest.length) bad.push(`wrangler.test.jsonc missing: ${missingTest.join(', ')}`);
  if (missingEnv.length) bad.push(`env.ts missing: ${missingEnv.join(', ')}`);
  if (bad.length) return { name: 'wrangler-bindings', ok: false, detail: bad.join('; ') };
  return { name: 'wrangler-bindings', ok: true };
}

async function checkWranglerBindings(): Promise<R> {
  const prod = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  const test = readJsonc(join(REPO, 'apps/worker/wrangler.test.jsonc')) as Record<string, unknown>;
  const envBody =
    readFileSync(join(REPO, 'apps/worker/src/platform/env.ts'), 'utf8') +
    readFileSync(join(REPO, 'apps/worker/src/platform/worker-bindings.d.ts'), 'utf8');
  const envKeys = new Set<string>();
  for (const m of envBody.matchAll(/(\w+)\s*[?:]/g)) envKeys.add(m[1] ?? '');
  return evaluateWranglerBindings(prod, test, envKeys);
}

async function checkWranglerCompat(): Promise<R> {
  const w = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  const flags = (w['compatibility_flags'] as string[] | undefined) ?? [];
  if (!flags.includes('nodejs_compat'))
    return {
      name: 'wrangler-compat',
      ok: false,
      detail: 'missing "nodejs_compat" in compatibility_flags',
    };
  const date = w['compatibility_date'];
  if (typeof date !== 'string' || date.length === 0)
    return { name: 'wrangler-compat', ok: false, detail: 'compatibility_date is empty' };
  const t = Date.parse(date);
  if (Number.isNaN(t))
    return {
      name: 'wrangler-compat',
      ok: false,
      detail: `compatibility_date "${date}" not parseable`,
    };
  if (Date.now() - t > 2 * 365.25 * 86400 * 1000)
    return {
      name: 'wrangler-compat',
      ok: false,
      detail: `compatibility_date ${date} is older than 2 years`,
    };
  return { name: 'wrangler-compat', ok: true };
}

// Per CAP-004 every `NNNN_*.sql` ships with a companion `NNNN_*.verify.sql`.
// Both checks below skip the verify companions so they neither demand their
// own .verify.sql file nor double-count the sequence number.
const MIGRATION_FILE = /^\d{4}_.+(?<!verify)\.sql$/;
export function evaluateMigrationCompanionSources(sources: Readonly<Record<string, string>>): R {
  const invalid = Object.entries(sources)
    .filter(([, source]) => !/\bAS\s+assertion\b/i.test(source) || !/\bAS\s+pass\b/i.test(source))
    .map(([name]) => name);
  if (invalid.length > 0) {
    return {
      name: 'migrations-present',
      ok: false,
      detail: `verify files missing assertion/pass rows: ${invalid.join(', ')}`,
    };
  }
  return { name: 'migrations-present', ok: true };
}

async function checkMigrationsPresent(): Promise<R> {
  const dir = join(REPO, 'migrations');
  if (!statSync(dir, { throwIfNoEntry: false }))
    return { name: 'migrations-present', ok: true, detail: 'no migrations dir' };
  const all = readdirSync(dir);
  const sqls = all.filter((f) => MIGRATION_FILE.test(f));
  if (!sqls.length) return { name: 'migrations-present', ok: true, detail: 'no migrations yet' };
  const missing = sqls.filter((s) => !all.includes(s.replace(/\.sql$/, '.verify.sql')));
  if (missing.length)
    return {
      name: 'migrations-present',
      ok: false,
      detail: `missing verify files: ${missing.join(', ')}`,
    };
  const sources = Object.fromEntries(
    sqls.map((sql) => {
      const verify = sql.replace(/\.sql$/, '.verify.sql');
      return [verify, readFileSync(join(dir, verify), 'utf-8')];
    }),
  );
  return evaluateMigrationCompanionSources(sources);
}

async function checkMigrationsOrdered(): Promise<R> {
  const dir = join(REPO, 'migrations');
  if (!statSync(dir, { throwIfNoEntry: false })) return { name: 'migrations-ordered', ok: true };
  const seqs = readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .map((f) => parseInt(f.slice(0, 4), 10))
    .sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1)
      return {
        name: 'migrations-ordered',
        ok: false,
        detail: `expected ${String(i + 1).padStart(4, '0')}, found ${String(seqs[i]).padStart(4, '0')}`,
      };
  }
  return { name: 'migrations-ordered', ok: true };
}

// Schema-version vs migration history — CAP-004.
// Reads the highest-numbered migration filename under migrations/ and
// compares against CURRENT_SCHEMA_VERSION exported from
// apps/worker/src/database/schema-version.ts. Until CAP-006 lands the
// first installation_state row there is no DB row to compare against, so
// the sentinel in source is authoritative. Future capabilities that
// touch the schema must bump the constant and the migration number in
// lockstep.
async function checkSchemaVersion(): Promise<R> {
  const dir = join(REPO, 'migrations');
  if (!statSync(dir, { throwIfNoEntry: false })) {
    return { name: 'schema-version', ok: true, detail: 'no migrations dir' };
  }
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  if (!files.length) return { name: 'schema-version', ok: true, detail: 'no migrations yet' };
  const highest = files
    .map((f) => f.slice(0, 4))
    .sort()
    .pop();
  const sentinelPath = join(REPO, 'apps/worker/src/database/schema-version.ts');
  const src = readFileSync(sentinelPath, 'utf-8');
  const match = src.match(/CURRENT_SCHEMA_VERSION\s*=\s*'(\d{4})'/);
  if (!match)
    return {
      name: 'schema-version',
      ok: false,
      detail: `cannot parse CURRENT_SCHEMA_VERSION in ${sentinelPath}`,
    };
  const sentinel = match[1] ?? '';
  if (highest !== sentinel) {
    return {
      name: 'schema-version',
      ok: false,
      detail: `highest migration is ${highest} but CURRENT_SCHEMA_VERSION is '${sentinel}' — bump the sentinel in lockstep with new migrations`,
    };
  }
  return { name: 'schema-version', ok: true, detail: `${highest} matches schema-version.ts` };
}

// Encodes the module dependency table in .claude/rules/architecture.md.
const ALLOWED: Record<string, ReadonlySet<string>> = {
  identity: new Set(['platform', 'contracts', 'identity']),
  onboarding: new Set(['platform', 'contracts', 'identity', 'tenancy', 'outbound-mail', 'admin']),
  tenancy: new Set(['platform', 'contracts', 'identity']),
  messages: new Set(['platform', 'contracts', 'tenancy']),
  'inbound-mail': new Set(['platform', 'contracts', 'tenancy', 'messages', 'email-core']),
  'outbound-mail': new Set([
    'platform',
    'contracts',
    'tenancy',
    'messages',
    'email-core',
    'editor-assets',
    'signatures',
  ]),
  'provider-sync': new Set(['platform', 'contracts', 'messages']),
  attachments: new Set(['platform', 'contracts', 'messages', 'tenancy']),
  'editor-assets': new Set(['platform', 'contracts']),
  signatures: new Set(['platform', 'contracts', 'tenancy', 'editor-assets']),
  admin: new Set(['platform', 'contracts', 'identity', 'tenancy', 'messages', 'outbound-mail']),
  installation: new Set(['platform', 'contracts', 'identity', 'tenancy', 'admin']),
  maintenance: new Set(['platform', 'contracts', 'messages', 'tenancy', 'attachments']),
};
function targetModule(imp: string, from: string): string | null {
  if (!imp.startsWith('.')) return null;
  const abs = resolve(dirname(from), imp);
  const root = join(REPO, 'apps/worker/src/modules') + sep;
  if (!abs.startsWith(root)) return null;
  return abs.slice(root.length).split(sep)[0] ?? null;
}
async function checkModuleDependencyZones(): Promise<R> {
  const modulesDir = join(REPO, 'apps/worker/src/modules');
  if (!statSync(modulesDir, { throwIfNoEntry: false }))
    return { name: 'module-dependency-zones', ok: true };
  const modules = readdirSync(modulesDir).filter((d) =>
    statSync(join(modulesDir, d)).isDirectory(),
  );
  const importRe =
    /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))?\s+from\s+['"]([^'"]+)['"]/g;
  const bad: string[] = [];
  for (const m of modules) {
    for (const f of walk(join(modulesDir, m)).filter(
      (f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f),
    )) {
      const src = readFileSync(f, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(src)) !== null) {
        const t = targetModule(match[1] ?? '', f);
        // Intra-module imports (a file in `onboarding` importing a sibling in
        // `onboarding`) are always allowed — the dependency-zone rules govern
        // cross-module edges only.
        if (t && t !== m && !ALLOWED[m]?.has(t)) bad.push(`${m} → ${t}`);
      }
    }
  }
  if (bad.length) return { name: 'module-dependency-zones', ok: false, detail: bad.join('; ') };
  return { name: 'module-dependency-zones', ok: true };
}

async function checkEslintBoundaryRules(): Promise<R> {
  // Load the config so glob patterns in the source cannot fool the check.
  type Block = { rules?: Record<string, unknown> };
  type Zone = { target: string; from: ReadonlyArray<string> };
  const mod = (await import(`${REPO}/eslint.config.js`)) as { default: ReadonlyArray<Block> };
  const zones: Zone[] = [];
  const paths: Array<{ name: string }> = [];
  for (const block of mod.default) {
    const r = block.rules ?? {};
    const nrp = (r['import/no-restricted-paths'] as [unknown, { zones?: Zone[] }] | undefined)?.[1];
    if (nrp?.zones) zones.push(...nrp.zones);
    const nri = (
      r['no-restricted-imports'] as [unknown, { paths?: Array<{ name: string }> }] | undefined
    )?.[1];
    if (nri?.paths) paths.push(...nri.paths);
  }
  const has = (suffix: string, must: ReadonlyArray<string>) =>
    zones.some(
      (z) => z.target.endsWith(suffix) && z.from.some((f) => must.some((m) => f.includes(m))),
    );
  const miss: string[] = [];
  if (!has('/integrations', ['apps/worker/src/modules', 'apps/worker/src/entrypoints']))
    miss.push('integrations ↛ modules/http/entrypoints');
  if (!has('/modules', ['apps/worker/src/entrypoints'])) miss.push('modules ↛ entrypoints/http');
  if (!has('/platform', ['apps/worker/src/entrypoints'])) miss.push('platform ↛ entrypoints/http');
  if (!paths.some((p) => p.name === 'hono')) miss.push('no-restricted-imports hono');
  if (miss.length)
    return { name: 'eslint-boundary-rules', ok: false, detail: `missing: ${miss.join(', ')}` };
  return { name: 'eslint-boundary-rules', ok: true };
}

async function checkTsconfigStrict(): Promise<R> {
  const root = readJson<{ compilerOptions?: { strict?: boolean } }>(join(REPO, 'tsconfig.json'));
  if (root.compilerOptions?.strict !== true)
    return {
      name: 'tsconfig-strict',
      ok: false,
      detail: 'root tsconfig.json missing strict: true',
    };
  const paths = [
    'apps/worker',
    'apps/web',
    'packages/contracts',
    'packages/email-core',
    'packages/config',
    'packages/test-kit',
  ];
  const notExt = paths.filter(
    (p) =>
      !readJson<{ extends?: string }>(join(REPO, p, 'tsconfig.json')).extends?.includes(
        'tsconfig.json',
      ),
  );
  if (notExt.length)
    return {
      name: 'tsconfig-strict',
      ok: false,
      detail: `not extending root: ${notExt.join(', ')}`,
    };
  return { name: 'tsconfig-strict', ok: true };
}

async function checkHarnessNoPlaceholders(): Promise<R> {
  const pkgs = [
    'apps/worker',
    'apps/web',
    'packages/contracts',
    'packages/email-core',
    'packages/config',
    'packages/test-kit',
  ];
  const bad: string[] = [];
  for (const p of pkgs) {
    const pkg = readJson<{ scripts?: Record<string, string> }>(join(REPO, p, 'package.json'));
    for (const [n, v] of Object.entries(pkg.scripts ?? {})) {
      if ((n === 'test:unit' || n === 'test:worker') && !v.includes('vitest'))
        bad.push(`${p}/${n}="${v}"`);
    }
  }
  if (bad.length) return { name: 'harness-no-placeholders', ok: false, detail: bad.join('; ') };
  return { name: 'harness-no-placeholders', ok: true };
}

async function checkTestsCoverContracts(): Promise<R> {
  const src = readFileSync(join(REPO, 'packages/contracts/src/index.ts'), 'utf-8');
  const ts = readFileSync(join(REPO, 'packages/contracts/src/index.test.ts'), 'utf-8');
  const schemas: string[] = [];
  const re = /export\s+const\s+(\w+)\s*=\s*z\./g;
  let mtch: RegExpExecArray | null;
  while ((mtch = re.exec(src)) !== null) schemas.push(mtch[1] ?? '');
  const miss = schemas.filter(
    (s) =>
      !new RegExp(`\\b${s}\\b[\\s\\S]*?\\.parse\\(`).test(ts) ||
      !new RegExp(`\\b${s}\\b[\\s\\S]*?\\.safeParse\\(`).test(ts),
  );
  if (miss.length)
    return {
      name: 'tests-cover-contracts',
      ok: false,
      detail: `missing coverage: ${miss.join(', ')}`,
    };
  return { name: 'tests-cover-contracts', ok: true };
}

// ---------------------------------------------------------------------
// CAP-039 — three new checks. Pure evaluators over a parsed wrangler.jsonc
// shape; the async check* wrappers read the on-disk files and delegate to
// them so scripts/doctor.test.ts can drive the evaluators with synthetic
// fixtures.

// (a) web-assets-binding — `assets: { directory, binding }` block exists;
// the directory resolves to apps/web/dist/ (relative or absolute), the
// binding is the expected ASSETS string, the not_found_handling is the
// documented "single-page-application", and API/healthz requests are
// explicitly worker-first so SPA fallback cannot swallow them.
export function evaluateWebAssetsBinding(w: Record<string, unknown>, repoRoot: string = REPO): R {
  const assets = w['assets'];
  if (!assets || typeof assets !== 'object') {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: 'apps/worker/wrangler.jsonc is missing the top-level `assets` block',
    };
  }
  const a = assets as {
    directory?: string;
    binding?: string;
    not_found_handling?: string;
    run_worker_first?: unknown;
  };
  if (a.binding !== 'ASSETS') {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: `assets.binding must be "ASSETS" (got ${JSON.stringify(a.binding)})`,
    };
  }
  if (typeof a.directory !== 'string' || a.directory.length === 0) {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: 'assets.directory must be set to a non-empty path',
    };
  }
  // Resolve relative to apps/worker/wrangler.jsonc (wrangler 4.x behaviour).
  const wranglerDir = join(repoRoot, 'apps/worker');
  const resolvedDir = resolve(wranglerDir, a.directory);
  const expectedDir = resolve(repoRoot, 'apps/web/dist');
  if (resolvedDir !== expectedDir) {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: `assets.directory resolves to ${resolvedDir}, expected ${expectedDir}`,
    };
  }
  if (a.not_found_handling !== 'none') {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: `assets.not_found_handling must be "none" (got ${JSON.stringify(a.not_found_handling)})`,
    };
  }
  if (!Array.isArray(a.run_worker_first)) {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: 'assets.run_worker_first must include /api/* and /healthz',
    };
  }
  const workerFirst = new Set(
    a.run_worker_first.filter((entry): entry is string => typeof entry === 'string'),
  );
  const missingWorkerFirst = ['/api', '/api/*', '/healthz', '/healthz/*', '/readyz'].filter(
    (pattern) => !workerFirst.has(pattern),
  );
  if (missingWorkerFirst.length > 0) {
    return {
      name: 'web-assets-binding',
      ok: false,
      detail: `assets.run_worker_first is missing ${missingWorkerFirst.join(', ')}`,
    };
  }
  return { name: 'web-assets-binding', ok: true };
}

async function checkWebAssetsBinding(): Promise<R> {
  const w = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  return evaluateWebAssetsBinding(w);
}

// (b) queue-consumer-topology — every entry in queues.producers[] has a
// matching queue name in queues.consumers[] and vice versa. The producer
// must be a binding on the Worker; the consumer must declare max_retries
// (D1 — `max_retries: 5`). `dead_letter_queue` is allowed but optional
// (Q1).
//
// Topology parity between wrangler.jsonc and wrangler.test.jsonc is
// verified by COUNT, not name — the test pool legitimately runs against
// queue names like `test-outbound`, but a producer-only or consumer-only
// drift between the two files indicates a forgotten binding or a missing
// queue consumer that the worker-pool tests wouldn't catch.
type _Consumer = { queue: string; max_retries?: number; dead_letter_queue?: string };
type _Producer = { queue: string };
const _collectQueues = (
  cfg: Record<string, unknown>,
): { producers: _Producer[]; consumers: _Consumer[] } => {
  const q = cfg['queues'] as { producers?: _Producer[]; consumers?: _Consumer[] } | undefined;
  return {
    producers: q?.producers ?? [],
    consumers: q?.consumers ?? [],
  };
};

export function evaluateQueueConsumerTopology(
  prodCfg: Record<string, unknown>,
  testCfg: Record<string, unknown>,
): R {
  const prod = _collectQueues(prodCfg);
  const cons = _collectQueues(prodCfg);
  const consSet = new Set(cons.consumers.map((c) => c.queue));
  const prodSet = new Set(prod.producers.map((p) => p.queue));

  const deadLetters = new Set(cons.consumers.map((c) => c.dead_letter_queue).filter(Boolean));
  const missingConsumer = prod.producers
    .map((p) => p.queue)
    .filter((p) => !consSet.has(p) && !deadLetters.has(p));
  const missingProducer = cons.consumers.map((c) => c.queue).filter((q) => !prodSet.has(q));
  const missingRetries = cons.consumers.filter((c) => typeof c.max_retries !== 'number');
  const bad: string[] = [];
  if (missingConsumer.length)
    bad.push(`producers without matching consumer: ${missingConsumer.join(', ')}`);
  if (missingProducer.length)
    bad.push(`consumers without matching producer: ${missingProducer.join(', ')}`);
  if (missingRetries.length)
    bad.push(`consumers missing max_retries: ${missingRetries.map((c) => c.queue).join(', ')}`);

  const tprod = _collectQueues(testCfg);
  const tcons = _collectQueues(testCfg);
  if (tprod.producers.length !== prod.producers.length)
    bad.push(
      `wrangler.test.jsonc has ${tprod.producers.length} producers; wrangler.jsonc has ${prod.producers.length}`,
    );
  if (tcons.consumers.length !== cons.consumers.length)
    bad.push(
      `wrangler.test.jsonc has ${tcons.consumers.length} consumers; wrangler.jsonc has ${cons.consumers.length}`,
    );

  // CAP-039 D6 — disjointness assertion. Queue names in `wrangler.jsonc`
  // and queue names in `wrangler.test.jsonc` must be disjoint: each
  // queue appears in exactly one config, never both. A rename in one
  // config that wasn't propagated to the other (e.g. someone adds a
  // queue to wrangler.test.jsonc using the production name, so the
  // test pool drains production-side messages) is caught here. Count
  // parity alone misses this because each config still declares the
  // same number of queues. Producers and consumers within a single
  // config are already matched by name above; the disjointness check
  // looks at the union of producers and consumers on each side and
  // asserts no overlap.
  const prodAll = new Set([
    ...prod.producers.map((p) => p.queue),
    ...cons.consumers.map((c) => c.queue),
  ]);
  const testAll = new Set([
    ...tprod.producers.map((p) => p.queue),
    ...tcons.consumers.map((c) => c.queue),
  ]);
  const overlap = [...prodAll].filter((q) => testAll.has(q));
  if (overlap.length)
    bad.push(
      `queue name drift: ${overlap.join(', ')} appears in both wrangler.jsonc and wrangler.test.jsonc (rename one)`,
    );

  if (bad.length) return { name: 'queue-consumer-topology', ok: false, detail: bad.join('; ') };
  return { name: 'queue-consumer-topology', ok: true };
}

async function checkQueueConsumerTopology(): Promise<R> {
  const w = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  const wt = readJsonc(join(REPO, 'apps/worker/wrangler.test.jsonc')) as Record<string, unknown>;
  return evaluateQueueConsumerTopology(w, wt);
}

// (c) migration-strategy-pending-only — wrangler.jsonc.d1_databases[i].migrations_dir
// is unset (or every entry's migrations_dir is absent) and no top-level
// `apply_migrations: true` is set. Pending-only deploy is the sole
// authority. If either reappears the operator can quietly lose track of
// which path is migrating the production DB.
export function evaluateMigrationStrategyPendingOnly(w: Record<string, unknown>): R {
  if (w['apply_migrations'] === true) {
    return {
      name: 'migration-strategy-pending-only',
      ok: false,
      detail:
        'top-level `apply_migrations: true` is set — remove it; deploy.ts:runRemoteMigrations is the sole authority',
    };
  }
  const dbs = (w['d1_databases'] as Array<Record<string, unknown>> | undefined) ?? [];
  for (const [i, db] of dbs.entries()) {
    if ('migrations_dir' in db && db['migrations_dir']) {
      return {
        name: 'migration-strategy-pending-only',
        ok: false,
        detail: `d1_databases[${i}].migrations_dir is set to ${JSON.stringify(db['migrations_dir'])} — remove it; deploy.ts:runRemoteMigrations is the sole authority`,
      };
    }
  }
  return { name: 'migration-strategy-pending-only', ok: true };
}

async function checkMigrationStrategyPendingOnly(): Promise<R> {
  const w = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  return evaluateMigrationStrategyPendingOnly(w);
}

// CAP-045 — preview verification gate (executable suite + operator runbook).
// Pure evaluator over three on-disk files: the suite, the operator helper,
// and the runbook. Also asserts the suite + helper do NOT contain patterns
// that would defeat the worker-pool binding discipline (e.g. mocking the
// test runner itself, stubbing D1's `db.prepare`) or leak the production
// API key into committed source.
//
// `fsRead` is the filesystem accessor for testability — the caller passes
// `readFileSync` in production and a fixture reader in tests, mirroring the
// pattern established by `evaluateMigrationsPresent` (CAP-039).
const PREVIEW_GATE_PATHS = {
  suite: 'apps/worker/test/preview-gate.worker.test.ts',
  helper: 'scripts/send-test-brevo.ts',
  runbook: 'work/reviews/CAP-045-preview-runbook.md',
} as const;

// HIGH 7 fix: extend the disqualifying-pattern set so the helper is also
// scanned for credential-leak shapes. The two known-safe string literals
// (`BREVO_API_KEY` and `api-key`) inside the helper are exceptions — every
// other assignment shape is an immediate fail. The matched `unescaped`
// patterns are value-bearing (`key = "..."`, `key: "..."`).
const HELPER_KEY_LEAK_PATTERN =
  /(BREVO_API_KEY\s*[:=]\s*["'`]|api[_-]?key\s*[:=]\s*["'`][^\s"']{8,})/;

export function evaluatePreviewGateSuitePresent({
  fsRead,
}: {
  fsRead: (path: string) => string | null;
}): R {
  const missing: string[] = [];
  for (const [name, path] of Object.entries(PREVIEW_GATE_PATHS)) {
    const content = fsRead(path);
    if (content === null) {
      missing.push(`${name}: ${path}`);
      continue;
    }
    // Disqualifying patterns — would defeat the worker-pool binding
    // discipline OR leak credential material. Catching them here keeps a
    // sloppy future edit from bypassing the real D1/KV/Queue/Console
    // surface and hiding bugs, or from committing the operator API key.
    if (path === PREVIEW_GATE_PATHS.suite && /vi\.mock\(\s*['"]cloudflare:test['"]/.test(content)) {
      return {
        name: 'preview-gate-suite-present',
        ok: false,
        detail: `suite file mocks 'cloudflare:test' — defeats worker-pool binding discipline; remove the mock and drive the real binding`,
      };
    }
    if (
      path === PREVIEW_GATE_PATHS.suite &&
      // Catches three forms on a SINGLE LINE (no cross-line false
      // positives from `mockResolvedValue(...)` on globalThis.fetch plus
      // a later `db.prepare(...)` real call elsewhere in the file):
      //   1. Chain: db.prepare.mockResolvedValue(...)
      //   2. Wrapping: vi.spyOn(db.prepare, ...)
      //   3. Reference: mockResolvedValue(db.prepare, ...)
      // Any of them means the suite mocks the D1 binding — defeats the
      // worker-pool binding discipline. Real D1 only.
      /db\.prepare[^\n]*\.mockResolvedValue|vi\.spyOn[^\n]*db\.prepare|mockResolvedValue\s*\([^\n]*db\.prepare/.test(
        content,
      )
    ) {
      return {
        name: 'preview-gate-suite-present',
        ok: false,
        detail: `suite file mocks db.prepare — defeats worker-pool binding discipline; drive the real D1 binding instead`,
      };
    }
    if (path === PREVIEW_GATE_PATHS.helper && HELPER_KEY_LEAK_PATTERN.test(content)) {
      return {
        name: 'preview-gate-suite-present',
        ok: false,
        detail: `helper file contains a credential assignment — never commit BREVO_API_KEY; the helper reads it from env only`,
      };
    }
  }
  if (missing.length) {
    return {
      name: 'preview-gate-suite-present',
      ok: false,
      detail: `missing files: ${missing.join('; ')}`,
    };
  }
  return { name: 'preview-gate-suite-present', ok: true };
}

async function checkPreviewGateSuitePresent(): Promise<R> {
  return evaluatePreviewGateSuitePresent({
    fsRead: (path) => {
      try {
        return readFileSync(join(REPO, path), 'utf-8');
      } catch {
        return null;
      }
    },
  });
}

const CHECKS: ReadonlyArray<Ck> = [
  checkWranglerBindings,
  checkWranglerCompat,
  checkMigrationsPresent,
  checkMigrationsOrdered,
  checkSchemaVersion,
  checkModuleDependencyZones,
  checkEslintBoundaryRules,
  checkTsconfigStrict,
  checkHarnessNoPlaceholders,
  checkTestsCoverContracts,
  checkWebAssetsBinding,
  checkQueueConsumerTopology,
  checkMigrationStrategyPendingOnly,
  checkPreviewGateSuitePresent,
];
async function main(): Promise<void> {
  const results: R[] = [];
  for (const c of CHECKS) results.push(await c());
  let passed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`✓ ${r.name}`);
      passed++;
    } else console.log(`✗ ${r.name} — ${r.detail ?? 'failed'}`);
  }
  console.log(`${passed}/${results.length} checks passed.`);
  if (passed < results.length) process.exit(1);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
