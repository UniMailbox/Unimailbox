import { mkdirSync, writeFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { first, objects, type DeploymentTarget } from '#scripts/deployment-config';
import { requireSuccess, type WranglerCommand } from '#scripts/deployment-runtime';

export interface SecretMetadata {
  name: string;
  id: string;
  active: boolean;
  scopes: string[];
}
// The pinned Wrangler CLI has no JSON option for this metadata command. Parse exact
// table cells, require the declared header, and never use substring identity.
export function parseSecretMetadata(output: string): SecretMetadata[] {
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
  if (!header || header[0] !== 'Name' || header[1] !== 'ID' || header[4] !== 'Status')
    throw new Error('Unexpected Secrets Store list format.');
  return rows.map((row) => {
    if (!row[0] || !row[1] || !/^[a-f0-9]{32}$/.test(row[1]))
      throw new Error('Invalid secret metadata row.');
    return {
      name: row[0],
      id: row[1],
      active: row[4] === 'active',
      scopes: (row[3] ?? '').split(',').map((s) => s.trim()),
    };
  });
}
export function listSecrets(wrangler: WranglerCommand, storeId: string): SecretMetadata[] {
  const entries: SecretMetadata[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = wrangler([
      'secrets-store',
      'secret',
      'list',
      storeId,
      '--remote',
      '--per-page',
      '100',
      '--page',
      String(page),
    ]);
    // This pinned CLI returns exit 1 for an empty page. Only its exact empty
    // response is accepted; authentication/network failures must still abort.
    if (
      result.status !== 0 &&
      /List request returned no secrets\./.test(`${result.stdout}\n${result.stderr}`)
    )
      return entries;
    const output = requireSuccess(result, 'Read remote secret metadata');
    const next = parseSecretMetadata(output);
    entries.push(...next);
    if (next.length < 100) return entries;
  }
  throw new Error('Secrets Store pagination did not terminate.');
}
export function assertSecretsExist(wrangler: WranglerCommand, target: DeploymentTarget): void {
  for (const storeId of new Set(target.secrets.map((secret) => secret.storeId))) {
    const entries = listSecrets(wrangler, storeId);
    for (const secret of target.secrets.filter((r) => r.storeId === storeId)) {
      if (
        entries.filter((r) => r.name === secret.name && r.active && r.scopes.includes('workers'))
          .length !== 1
      )
        throw new Error(
          `Missing or ambiguous remote secret: ${secret.binding}. Run bootstrap explicitly.`,
        );
    }
  }
}
function saveRecoveryValue(
  repo: string,
  target: DeploymentTarget,
  binding: string,
  value: string,
): void {
  const dir = resolve(repo, '.tmp/secret-recovery', target.accountId, target.environment);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, `${binding}-${Date.now()}.txt`);
  writeFileSync(path, `${value}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`Store the protected recovery file in your secret manager: ${path}`);
}
export function createMissingSecrets(
  repo: string,
  wrangler: WranglerCommand,
  target: DeploymentTarget,
): void {
  for (const secret of target.secrets) {
    const entries = listSecrets(wrangler, secret.storeId);
    const matches = entries.filter((r) => r.name === secret.name);
    if (
      matches.length === 1 &&
      first(matches, 'secret').active &&
      first(matches, 'secret').scopes.includes('workers')
    )
      continue;
    if (matches.length)
      throw new Error(
        `Existing inactive/ambiguous secret ${secret.binding}; refusing to replace it.`,
      );
    const value = randomBytes(32).toString('hex');
    saveRecoveryValue(repo, target, secret.binding, value);
    requireSuccess(
      wrangler(
        [
          'secrets-store',
          'secret',
          'create',
          secret.storeId,
          '--remote',
          '--name',
          secret.name,
          '--scopes',
          'workers',
        ],
        `${value}\n`,
      ),
      `Create ${secret.binding}`,
    );
    // A successful create can precede list visibility/activation by a few seconds.
    // Retry only metadata reads; never recreate or replace the generated value.
    let verified: SecretMetadata[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
      verified = listSecrets(wrangler, secret.storeId).filter(
        (r) => r.name === secret.name && r.active && r.scopes.includes('workers'),
      );
      if (verified.length > 0) break;
    }
    if (verified.length !== 1)
      throw new Error(`Cannot confirm created remote secret ${secret.binding}.`);
  }
}
export function rotateSecret(
  repo: string,
  wrangler: WranglerCommand,
  target: DeploymentTarget,
  binding: string,
): void {
  if (binding !== 'INSTALLATION_TOKEN' && binding !== 'CURSOR_SIGNING_KEY') {
    throw new Error(
      'Only INSTALLATION_TOKEN or CURSOR_SIGNING_KEY can be rotated. Data encryption key rotation requires a separate re-encryption migration.',
    );
  }
  const secret = first(
    target.secrets.filter((r) => r.binding === binding),
    'secret binding',
  );
  const matches = listSecrets(wrangler, secret.storeId).filter(
    (r) => r.name === secret.name && r.active && r.scopes.includes('workers'),
  );
  if (matches.length !== 1) throw new Error(`Missing/ambiguous secret ${binding}.`);
  const value = randomBytes(32).toString('hex');
  saveRecoveryValue(repo, target, binding, value);
  requireSuccess(
    wrangler(
      [
        'secrets-store',
        'secret',
        'update',
        secret.storeId,
        '--remote',
        '--secret-id',
        first(matches, 'secret').id,
        '--scopes',
        'workers',
      ],
      `${value}\n`,
    ),
    `Rotate ${binding}`,
  );
  assertSecretsExist(wrangler, target);
}

export function provisionSecretStore(wrangler: WranglerCommand, target: DeploymentTarget): void {
  if (!target.secrets.some((r) => r.storeId === 'PROVISION')) return;
  if (target.secrets.some((r) => r.storeId !== 'PROVISION'))
    throw new Error('Configure one explicit store or PROVISION for all secret bindings.');
  const read = (): string[] => {
    const result = wrangler(['secrets-store', 'store', 'list', '--remote', '--per-page', '100']);
    if (
      result.status !== 0 &&
      /List request returned no stores\./.test(`${result.stdout}\n${result.stderr}`)
    )
      return [];
    const output = requireSuccess(result, 'Read account Secrets Stores');
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
    if (header?.[0] !== 'Name' || header[1] !== 'ID')
      throw new Error('Unexpected Secrets Store format.');
    return rows.map((row) => {
      if (!row[1] || !/^[a-f0-9]{32}$/.test(row[1])) throw new Error('Invalid Secrets Store id.');
      return row[1];
    });
  };
  let stores = read();
  if (!stores.length) {
    requireSuccess(
      wrangler(['secrets-store', 'store', 'create', 'default_secrets_store', '--remote']),
      'Create account Secrets Store',
    );
    stores = read();
  }
  if (stores.length !== 1)
    throw new Error('Select an explicit store_id; more than one account store exists.');
  for (const row of objects(target.raw.secrets_store_secrets, 'secrets'))
    row.store_id = first(stores, 'store');
  for (const secret of target.secrets) secret.storeId = first(stores, 'store');
}
