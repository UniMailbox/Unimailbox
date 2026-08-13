#!/usr/bin/env node
// scripts/doctor.ts — CAP-003. Exits 0 if all 10 structural checks pass.
// See work/active/CAP-003-scaffold-doctor/task.md. Doctor reports; does
// not fix. No remote calls, no imports from apps/worker/src/*.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';

const REPO = resolve(new URL('..', import.meta.url).pathname);
type R = { name: string; ok: boolean; detail?: string }; type Ck = () => Promise<R>;

function readJsonc(p: string): unknown {
  const s = readFileSync(p, 'utf-8');
  return JSON.parse(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
}
function readJson<T>(p: string): T { return JSON.parse(readFileSync(p, 'utf-8')) as T; }
function walk(d: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    out.push(...(statSync(p).isDirectory() ? walk(p) : [p]));
  }
  return out;
}

const BINDS = ['DB','ATTACHMENTS','SETUP_SESSION','CACHE','OUTBOUND','INSTALLATION_TOKEN','CREDENTIAL_ENCRYPTION_KEY','ENVIRONMENT'];
async function checkWranglerBindings(): Promise<R> {
  const w = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  const have = new Set<string>();
  for (const x of (w['d1_databases'] as Array<{binding:string}>|undefined ?? [])) have.add(x.binding);
  for (const x of (w['r2_buckets'] as Array<{binding:string}>|undefined ?? [])) have.add(x.binding);
  for (const x of (w['kv_namespaces'] as Array<{binding:string}>|undefined ?? [])) have.add(x.binding);
  for (const x of ((w['queues'] as {producers?:Array<{binding:string}>}|undefined)?.producers ?? [])) have.add(x.binding);
  for (const x of (w['secrets_store_secrets'] as Array<{binding:string}>|undefined ?? [])) have.add(x.binding);
  for (const k of Object.keys((w['vars'] as Record<string,unknown>|undefined) ?? {})) have.add(k);
  const envBody = readFileSync(join(REPO, 'apps/worker/src/platform/env.ts'), 'utf-8').match(/type\s+Env\s*=\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const envKeys = new Set<string>();
  for (const m of envBody.matchAll(/(\w+)\s*[?:]/g)) envKeys.add(m[1] ?? '');
  if (BINDS.some(n => !have.has(n))) return { name: 'wrangler-bindings', ok: false, detail: `wrangler.jsonc missing: ${BINDS.filter(n => !have.has(n)).join(', ')}` };
  if (BINDS.some(n => !envKeys.has(n))) return { name: 'wrangler-bindings', ok: false, detail: `env.ts missing: ${BINDS.filter(n => !envKeys.has(n)).join(', ')}` };
  return { name: 'wrangler-bindings', ok: true };
}

async function checkWranglerCompat(): Promise<R> {
  const w = readJsonc(join(REPO, 'apps/worker/wrangler.jsonc')) as Record<string, unknown>;
  const flags = (w['compatibility_flags'] as string[]|undefined) ?? [];
  if (!flags.includes('nodejs_compat')) return { name: 'wrangler-compat', ok: false, detail: 'missing "nodejs_compat" in compatibility_flags' };
  const date = w['compatibility_date'];
  if (typeof date !== 'string' || date.length === 0) return { name: 'wrangler-compat', ok: false, detail: 'compatibility_date is empty' };
  const t = Date.parse(date);
  if (Number.isNaN(t)) return { name: 'wrangler-compat', ok: false, detail: `compatibility_date "${date}" not parseable` };
  if (Date.now() - t > 2 * 365.25 * 86400 * 1000) return { name: 'wrangler-compat', ok: false, detail: `compatibility_date ${date} is older than 2 years` };
  return { name: 'wrangler-compat', ok: true };
}

// Per CAP-004 every `NNNN_*.sql` ships with a companion `NNNN_*.verify.sql`.
// Both checks below skip the verify companions so they neither demand their
// own .verify.sql file nor double-count the sequence number.
const MIGRATION_FILE = /^\d{4}_.+(?<!verify)\.sql$/;
async function checkMigrationsPresent(): Promise<R> {
  const dir = join(REPO, 'migrations');
  if (!statSync(dir, { throwIfNoEntry: false })) return { name: 'migrations-present', ok: true, detail: 'no migrations dir' };
  const all = readdirSync(dir);
  const sqls = all.filter(f => MIGRATION_FILE.test(f));
  if (!sqls.length) return { name: 'migrations-present', ok: true, detail: 'no migrations yet' };
  const missing = sqls.filter(s => !all.includes(s.replace(/\.sql$/, '.verify.sql')));
  if (missing.length) return { name: 'migrations-present', ok: false, detail: `missing verify files: ${missing.join(', ')}` };
  return { name: 'migrations-present', ok: true };
}

async function checkMigrationsOrdered(): Promise<R> {
  const dir = join(REPO, 'migrations');
  if (!statSync(dir, { throwIfNoEntry: false })) return { name: 'migrations-ordered', ok: true };
  const seqs = readdirSync(dir).filter(f => MIGRATION_FILE.test(f)).map(f => parseInt(f.slice(0,4), 10)).sort((a,b)=>a-b);
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) return { name: 'migrations-ordered', ok: false, detail: `expected ${String(i+1).padStart(4,'0')}, found ${String(seqs[i]).padStart(4,'0')}` };
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
  const highest = files.map((f) => f.slice(0, 4)).sort().pop();
  const sentinelPath = join(REPO, 'apps/worker/src/database/schema-version.ts');
  const src = readFileSync(sentinelPath, 'utf-8');
  const match = src.match(/CURRENT_SCHEMA_VERSION\s*=\s*'(\d{4})'/);
  if (!match) return { name: 'schema-version', ok: false, detail: `cannot parse CURRENT_SCHEMA_VERSION in ${sentinelPath}` };
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
  identity: new Set(['platform','contracts','identity']),
  onboarding: new Set(['platform','contracts','identity','tenancy','outbound-mail','admin']),
  tenancy: new Set(['platform','contracts','identity']),
  messages: new Set(['platform','contracts','tenancy']),
  'inbound-mail': new Set(['platform','contracts','tenancy','messages','email-core']),
  'outbound-mail': new Set(['platform','contracts','tenancy','messages','email-core']),
  'provider-sync': new Set(['platform','contracts','messages']),
  attachments: new Set(['platform','contracts','messages','tenancy']),
  signatures: new Set(['platform','contracts','tenancy']),
  admin: new Set(['platform','contracts','identity','tenancy','messages','outbound-mail']),
  installation: new Set(['platform','contracts','identity','tenancy','admin']),
  maintenance: new Set(['platform','contracts','messages','tenancy','attachments']),
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
  if (!statSync(modulesDir, { throwIfNoEntry: false })) return { name: 'module-dependency-zones', ok: true };
  const modules = readdirSync(modulesDir).filter(d => statSync(join(modulesDir, d)).isDirectory());
  const importRe = /import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))?\s+from\s+['"]([^'"]+)['"]/g;
  const bad: string[] = [];
  for (const m of modules) {
    for (const f of walk(join(modulesDir, m)).filter(f => f.endsWith('.ts') && !/\.test\.ts$/.test(f))) {
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
  const zones: Zone[] = []; const paths: Array<{ name: string }> = [];
  for (const block of mod.default) {
    const r = block.rules ?? {};
    const nrp = (r['import/no-restricted-paths'] as [unknown, { zones?: Zone[] }] | undefined)?.[1];
    if (nrp?.zones) zones.push(...nrp.zones);
    const nri = (r['no-restricted-imports'] as [unknown, { paths?: Array<{ name: string }> }] | undefined)?.[1];
    if (nri?.paths) paths.push(...nri.paths);
  }
  const has = (suffix: string, must: ReadonlyArray<string>) => zones.some(z => z.target.endsWith(suffix) && z.from.some(f => must.some(m => f.includes(m))));
  const miss: string[] = [];
  if (!has('/integrations', ['apps/worker/src/modules','apps/worker/src/entrypoints'])) miss.push('integrations ↛ modules/http/entrypoints');
  if (!has('/modules', ['apps/worker/src/entrypoints'])) miss.push('modules ↛ entrypoints/http');
  if (!has('/platform', ['apps/worker/src/entrypoints'])) miss.push('platform ↛ entrypoints/http');
  if (!paths.some(p => p.name === 'hono')) miss.push('no-restricted-imports hono');
  if (miss.length) return { name: 'eslint-boundary-rules', ok: false, detail: `missing: ${miss.join(', ')}` };
  return { name: 'eslint-boundary-rules', ok: true };
}

async function checkTsconfigStrict(): Promise<R> {
  const root = readJson<{compilerOptions?:{strict?:boolean}}>(join(REPO, 'tsconfig.json'));
  if (root.compilerOptions?.strict !== true) return { name: 'tsconfig-strict', ok: false, detail: 'root tsconfig.json missing strict: true' };
  const paths = ['apps/worker','apps/web','packages/contracts','packages/email-core','packages/config','packages/test-kit'];
  const notExt = paths.filter(p => !readJson<{extends?:string}>(join(REPO, p, 'tsconfig.json')).extends?.includes('tsconfig.json'));
  if (notExt.length) return { name: 'tsconfig-strict', ok: false, detail: `not extending root: ${notExt.join(', ')}` };
  return { name: 'tsconfig-strict', ok: true };
}

async function checkHarnessNoPlaceholders(): Promise<R> {
  const pkgs = ['apps/worker','apps/web','packages/contracts','packages/email-core','packages/config','packages/test-kit'];
  const bad: string[] = [];
  for (const p of pkgs) {
    const pkg = readJson<{scripts?:Record<string,string>}>(join(REPO, p, 'package.json'));
    for (const [n, v] of Object.entries(pkg.scripts ?? {})) {
      if ((n === 'test:unit' || n === 'test:worker') && !v.includes('vitest')) bad.push(`${p}/${n}="${v}"`);
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
  const miss = schemas.filter(s => !new RegExp(`\\b${s}\\b[\\s\\S]*?\\.parse\\(`).test(ts) || !new RegExp(`\\b${s}\\b[\\s\\S]*?\\.safeParse\\(`).test(ts));
  if (miss.length) return { name: 'tests-cover-contracts', ok: false, detail: `missing coverage: ${miss.join(', ')}` };
  return { name: 'tests-cover-contracts', ok: true };
}

const CHECKS: ReadonlyArray<Ck> = [
  checkWranglerBindings, checkWranglerCompat, checkMigrationsPresent,
  checkMigrationsOrdered, checkSchemaVersion, checkModuleDependencyZones,
  checkEslintBoundaryRules, checkTsconfigStrict, checkHarnessNoPlaceholders,
  checkTestsCoverContracts,
];
async function main(): Promise<void> {
  const results: R[] = [];
  for (const c of CHECKS) results.push(await c());
  let passed = 0;
  for (const r of results) {
    if (r.ok) { console.log(`✓ ${r.name}`); passed++; }
    else console.log(`✗ ${r.name} — ${r.detail ?? 'failed'}`);
  }
  console.log(`${passed}/${results.length} checks passed.`);
  if (passed < results.length) process.exit(1);
}
await main();