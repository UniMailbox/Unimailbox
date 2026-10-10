import { writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { first, objects, type DeploymentTarget } from '#scripts/deployment-config';
import { parseWranglerList } from '#scripts/deployment-parsers';
import { requireSuccess, type WranglerCommand } from '#scripts/deployment-runtime';

function list(wrangler: WranglerCommand, args: string[]): Array<Record<string, unknown>> {
  const result = wrangler(args);
  requireSuccess(result, `Read ${args.join(' ')}`);
  const parsed = parseWranglerList<Record<string, unknown>>(result, args.join(' '));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}
function databaseId(
  wrangler: WranglerCommand,
  target: DeploymentTarget,
  provision: boolean,
): string {
  const find = (): Array<Record<string, unknown>> =>
    list(wrangler, ['d1', 'list', '--json']).filter((r) => r.name === target.database.name);
  let matches = find();
  if (!matches.length && provision) {
    requireSuccess(wrangler(['d1', 'create', target.database.name]), 'Create database');
    matches = find(); // Never parse a create command's JSONC/TOML snippet.
  }
  if (matches.length !== 1 || typeof first(matches, 'resource').uuid !== 'string')
    throw new Error('Cannot resolve the declared D1 database.');
  const id = first(matches, 'resource').uuid;
  if (typeof id !== 'string') throw new Error('Invalid database id.');
  if (target.database.id !== 'PROVISION' && id !== target.database.id)
    throw new Error('D1 account/name/id mismatch.');
  return id;
}
function namespaceId(
  wrangler: WranglerCommand,
  target: DeploymentTarget,
  binding: string,
  configuredId: string,
  provision: boolean,
): string {
  const title = `${target.worker}-${binding.toLowerCase().replaceAll('_', '-')}`;
  const find = (): Array<Record<string, unknown>> =>
    list(wrangler, ['kv', 'namespace', 'list']).filter((r) =>
      configuredId === 'PROVISION' ? r.title === title : r.id === configuredId,
    );
  let matches = find();
  if (!matches.length && configuredId === 'PROVISION' && provision) {
    requireSuccess(wrangler(['kv', 'namespace', 'create', title]), `Create ${binding}`);
    matches = find();
  }
  if (matches.length !== 1 || typeof first(matches, 'resource').id !== 'string')
    throw new Error(`Cannot resolve ${binding} in the selected account.`);
  const id = first(matches, 'resource').id;
  if (typeof id !== 'string') throw new Error('Invalid namespace id.');
  return id;
}
export function bucketNames(output: string): string[] {
  try {
    const rows: unknown = JSON.parse(output);
    if (Array.isArray(rows))
      return rows.map((r) => {
        if (!r || typeof r !== 'object' || !('name' in r) || typeof r.name !== 'string')
          throw new Error('Invalid bucket row.');
        return r.name;
      });
  } catch {
    /* Wrangler 4.121 uses labelled output. */
  }
  const names = Array.from(output.matchAll(/^name:\s+(\S+)\s*$/gm), (m) =>
    first(m.slice(1), 'bucket name'),
  );
  if (!names.length && !/No buckets|No R2 buckets/i.test(output))
    throw new Error('Unexpected R2 list format.');
  return names;
}
export function queueNames(output: string): string[] {
  const rows = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .filter((line) => line.trimStart().startsWith('│'))
    .map((line) =>
      line
        .split('│')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  const header = rows.shift();
  const column = header?.findIndex((cell) => /^name$|^queue name$/i.test(cell)) ?? -1;
  if (column < 0) {
    if (/No queues/i.test(output)) return [];
    throw new Error('Unexpected queue list format.');
  }
  return rows.map((row) => {
    const name = row[column];
    if (!name || !/^[a-z0-9_-]+$/.test(name)) throw new Error('Invalid queue name.');
    return name;
  });
}
export function ensureResources(
  wrangler: WranglerCommand,
  target: DeploymentTarget,
  provision = false,
): void {
  const dbId = databaseId(wrangler, target, provision);
  const namespaces = target.namespaces.map((r) => ({
    binding: r.binding,
    id: namespaceId(wrangler, target, r.binding, r.id, provision),
  }));
  let buckets = bucketNames(requireSuccess(wrangler(['r2', 'bucket', 'list']), 'List R2 buckets'));
  if (!buckets.includes(target.bucket) && provision) {
    requireSuccess(wrangler(['r2', 'bucket', 'create', target.bucket]), 'Create R2 bucket');
    buckets = bucketNames(requireSuccess(wrangler(['r2', 'bucket', 'list']), 'Confirm R2 bucket'));
  }
  if (!buckets.includes(target.bucket))
    throw new Error('Declared R2 bucket is missing. Run bootstrap explicitly.');
  for (const queue of [target.queue, target.deadLetterQueue]) {
    let queues = queueNames(requireSuccess(wrangler(['queues', 'list']), 'List queues'));
    if (!queues.includes(queue) && provision) {
      requireSuccess(wrangler(['queues', 'create', queue]), `Create ${queue}`);
      queues = queueNames(requireSuccess(wrangler(['queues', 'list']), 'Confirm queue'));
    }
    if (!queues.includes(queue))
      throw new Error(`Queue ${queue} is missing. Run bootstrap explicitly.`);
  }
  if (provision) {
    first(objects(target.raw.d1_databases, 'd1_databases'), 'DB').database_id = dbId;
    for (const row of objects(target.raw.kv_namespaces, 'kv_namespaces'))
      row.id = first(
        namespaces.filter((r) => r.binding === row.binding),
        'KV',
      ).id;
    writeFileSync(target.path, `${JSON.stringify(target.raw, null, 2)}\n`);
  }
}
