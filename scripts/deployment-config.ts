import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseJsonc } from '#scripts/jsonc';

export type DeployEnvironment = 'preview' | 'staging' | 'production';
export interface DeploymentTarget {
  environment: DeployEnvironment;
  path: string;
  raw: Record<string, unknown>;
  accountId: string;
  worker: string;
  origin: string;
  database: { name: string; id: string };
  bucket: string;
  namespaces: Array<{ binding: string; id: string }>;
  queue: string;
  deadLetterQueue: string;
  secrets: Array<{ binding: string; storeId: string; name: string }>;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
export function objects(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value.map((item) => object(item, label));
}
export function first<T>(items: readonly T[], label: string): T {
  const item = items[0];
  if (item === undefined) throw new Error(`Missing ${label}`);
  return item;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
  return value;
}
export function environment(value: string | undefined): DeployEnvironment {
  if (value !== 'preview' && value !== 'staging' && value !== 'production') {
    throw new Error('Select --environment preview|staging|production (or ENVIRONMENT).');
  }
  return value;
}

export function loadTarget(
  repo: string,
  env: DeployEnvironment,
  bootstrap = false,
): DeploymentTarget {
  const path = resolve(repo, `apps/worker/wrangler.${env}.jsonc`);
  if (!existsSync(path)) throw new Error(`Configure ${path} before deploying ${env}.`);
  const raw = object(parseJsonc(readFileSync(path, 'utf8')), 'Wrangler config');
  const prefix = `unimailbox-${env}`;
  const vars = object(raw.vars, 'vars');
  if (vars.ENVIRONMENT !== env || raw.name !== prefix)
    throw new Error('Worker/environment identity mismatch.');
  const accountId = text(raw.account_id, 'account_id');
  if (!/^[a-f0-9]{32}$/.test(accountId))
    throw new Error('Configure an explicit Cloudflare account_id.');
  const origin = text(vars.APP_ORIGIN, 'APP_ORIGIN');
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:')
    throw new Error('APP_ORIGIN must be an https origin.');
  const routes = objects(raw.routes, 'routes');
  if (!routes.some((r) => r.pattern === url.hostname && r.custom_domain === true)) {
    throw new Error('APP_ORIGIN must match a configured custom domain.');
  }
  if (raw.workers_dev !== false)
    throw new Error('Use the explicit custom domain; disable workers_dev.');
  const name = (value: unknown, label: string): string => {
    const result = text(value, label);
    if (!result.startsWith(`${prefix}-`)) throw new Error(`${label} must belong to ${prefix}.`);
    return result;
  };
  const id = (value: unknown, label: string, uuid = false): string => {
    const result = text(value, label);
    if (bootstrap && result === 'PROVISION') return result;
    if (
      !(
        uuid ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/ : /^[a-f0-9]{32}$/
      ).test(result)
    )
      throw new Error(`Unresolved ${label}.`);
    return result;
  };
  const databases = objects(raw.d1_databases, 'd1_databases');
  if (databases.length !== 1 || databases[0]?.binding !== 'DB')
    throw new Error('Expected exactly one DB binding.');
  const db = first(databases, 'DB');
  const buckets = objects(raw.r2_buckets, 'r2_buckets');
  if (buckets.length !== 1 || buckets[0]?.binding !== 'ATTACHMENTS')
    throw new Error('Expected ATTACHMENTS binding.');
  const namespaces = objects(raw.kv_namespaces, 'kv_namespaces').map((r) => ({
    binding: text(r.binding, 'KV binding'),
    id: id(r.id, 'KV id'),
  }));
  if (
    namespaces.length !== 2 ||
    !['CACHE', 'SETUP_SESSION'].every((b) => namespaces.some((r) => r.binding === b))
  ) {
    throw new Error('Expected CACHE and SETUP_SESSION KV bindings.');
  }
  if (new Set(namespaces.map((r) => r.id)).size !== 2 && !bootstrap)
    throw new Error('KV bindings must be distinct.');
  const queues = object(raw.queues, 'queues');
  const producers = objects(queues.producers, 'queue producers');
  const consumers = objects(queues.consumers, 'queue consumers');
  const outbound = producers.find((r) => r.binding === 'OUTBOUND');
  const dlq = producers.find((r) => r.binding === 'OUTBOUND_DLQ');
  if (
    producers.length !== 2 ||
    consumers.length !== 1 ||
    !outbound ||
    !dlq ||
    outbound.queue !== consumers[0]?.queue ||
    dlq.queue !== consumers[0]?.dead_letter_queue
  ) {
    throw new Error('Expected matched OUTBOUND consumer and OUTBOUND_DLQ metrics binding.');
  }
  const secrets = objects(raw.secrets_store_secrets, 'secrets_store_secrets').map((r) => ({
    binding: text(r.binding, 'secret binding'),
    storeId: id(r.store_id, 'store_id'),
    name: name(r.secret_name, 'secret name'),
  }));
  if (
    secrets.length !== 3 ||
    !['INSTALLATION_TOKEN', 'CREDENTIAL_ENCRYPTION_KEY', 'CURSOR_SIGNING_KEY'].every((b) =>
      secrets.some((r) => r.binding === b),
    )
  ) {
    throw new Error('Expected the three independent Secrets Store bindings.');
  }
  if (new Set(secrets.map((r) => `${r.storeId}/${r.name}`)).size !== 3)
    throw new Error('Secrets must have independent identities.');
  const target: DeploymentTarget = {
    environment: env,
    path,
    raw,
    accountId,
    worker: prefix,
    origin,
    database: {
      name: name(db.database_name, 'database name'),
      id: id(db.database_id, 'database_id', true),
    },
    bucket: name(first(buckets, 'bucket').bucket_name, 'bucket name'),
    namespaces,
    queue: name(outbound.queue, 'queue name'),
    deadLetterQueue: name(first(consumers, 'consumer').dead_letter_queue, 'DLQ name'),
    secrets,
  };
  if (target.queue === target.deadLetterQueue) throw new Error('DLQ must be a different queue.');
  return target;
}

export function assertAccount(
  target: DeploymentTarget,
  configuredAccount: string | undefined,
): void {
  if (configuredAccount && configuredAccount !== target.accountId)
    throw new Error('CLOUDFLARE_ACCOUNT_ID conflicts with the selected config.');
}

export function assertIsolation(repo: string, target: DeploymentTarget): void {
  for (const env of ['preview', 'staging', 'production'] as const) {
    if (
      env === target.environment ||
      !existsSync(resolve(repo, `apps/worker/wrangler.${env}.jsonc`))
    )
      continue;
    const other = loadTarget(repo, env, true);
    if (other.origin === target.origin) throw new Error(`Origin is shared with ${env}.`);
    if (other.accountId !== target.accountId) continue;
    const a = [
      target.database.id,
      target.bucket,
      target.queue,
      target.deadLetterQueue,
      ...target.namespaces.map((r) => r.id),
      ...target.secrets.map((r) => `${r.storeId}/${r.name}`),
    ];
    const b = [
      other.database.id,
      other.bucket,
      other.queue,
      other.deadLetterQueue,
      ...other.namespaces.map((r) => r.id),
      ...other.secrets.map((r) => `${r.storeId}/${r.name}`),
    ];
    if (a.some((value) => value !== 'PROVISION' && b.includes(value)))
      throw new Error(`Resources are shared with ${env}.`);
  }
}
