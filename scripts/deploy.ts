#!/usr/bin/env node
// Explicit environment release entry. Bootstrap and named secret rotation are
// separate operations; publishing never creates resources or replaces secrets.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  environment,
  loadTarget,
  assertAccount,
  assertIsolation,
  type DeploymentTarget,
} from '#scripts/deployment-config';
import {
  acquireDeployLock,
  assertMembership,
  createWrangler,
  requireSuccess,
  type WranglerCommand,
} from '#scripts/deployment-runtime';
import { ensureResources } from '#scripts/deployment-resources';
import {
  assertSecretsExist,
  createMissingSecrets,
  rotateSecret,
  provisionSecretStore,
} from '#scripts/deployment-secrets';
import { migrateAndVerify } from '#scripts/deployment-migrations';
import {
  activeVersion,
  prepareRelease,
  loadPreparedRelease,
  saveRelease,
  type ReleaseManifest,
} from '#scripts/deployment-release';
import { verifyPublishedRelease } from '#scripts/deployment-smoke';

export interface DeployOptions {
  environment: 'preview' | 'staging' | 'production';
  dryRun: boolean;
  bootstrap: boolean;
  prepared?: string;
  secret?: string;
}
export function parseDeployOptions(argv: string[], env: string | undefined): DeployOptions {
  if (argv.filter((v) => v === '--environment').length > 1)
    throw new Error('Select exactly one environment.');
  const options: DeployOptions = {
    environment: environment(
      argv.includes('--environment') ? argv[argv.indexOf('--environment') + 1] : env,
    ),
    dryRun: false,
    bootstrap: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--environment') {
      i++;
      continue;
    }
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--bootstrap') options.bootstrap = true;
    else if (arg === '--prepared' || arg === '--secret') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--prepared') options.prepared = value;
      else options.secret = value;
    } else
      throw new Error(
        `Unsupported deploy flag ${arg}. Bulk secret rotation and skipped migrations are disabled.`,
      );
  }
  if (env && env !== options.environment)
    throw new Error('ENVIRONMENT conflicts with --environment.');
  if (
    Number(options.bootstrap) +
      Number(Boolean(options.secret)) +
      Number(Boolean(options.prepared)) >
    1
  )
    throw new Error('Choose one deployment operation.');
  if (options.secret && !['INSTALLATION_TOKEN', 'CURSOR_SIGNING_KEY'].includes(options.secret))
    throw new Error(
      'Data encryption key rotation is disabled; select INSTALLATION_TOKEN or CURSOR_SIGNING_KEY.',
    );
  return options;
}

export async function publishRelease(
  repo: string,
  target: DeploymentTarget,
  path: string,
  manifest: ReleaseManifest,
  wrangler: WranglerCommand,
  smoke = verifyPublishedRelease,
): Promise<void> {
  try {
    assertMembership(wrangler, target);
    ensureResources(wrangler, target);
    assertSecretsExist(wrangler, target);
    const current = activeVersion(wrangler, true);
    if (
      manifest.previousVersion &&
      current !== manifest.previousVersion &&
      current !== manifest.version
    )
      throw new Error(
        'Active deployment changed since this release attempt. Prepare a new release.',
      );
    if (current && !manifest.previousVersion) manifest.previousVersion = current;
    if (!manifest.bookmark) {
      const bookmark = JSON.parse(
        requireSuccess(
          wrangler(['d1', 'time-travel', 'info', target.database.name, '--json']),
          'Capture D1 recovery bookmark',
        ),
      ) as { bookmark?: unknown };
      if (typeof bookmark.bookmark !== 'string' || !bookmark.bookmark)
        throw new Error('D1 recovery bookmark is missing.');
      manifest.bookmark = bookmark.bookmark;
    }
    manifest.phase = 'migrating';
    saveRelease(path, manifest);
    const migrations = migrateAndVerify(
      repo,
      wrangler,
      resolve(dirname(path), 'schema-verification'),
    );
    manifest.applied = [...new Set([...(manifest.applied ?? []), ...migrations.applied])];
    manifest.verified = migrations.verified;
    manifest.phase = 'deploying';
    saveRelease(path, manifest);
    // Revalidate the prepared identity after remote checks/migrations, so an
    // edited frontend or config cannot be published with an earlier green gate.
    const check = { ...manifest, phase: 'prepared' as const };
    saveRelease(path, check);
    loadPreparedRelease(repo, target, path);
    saveRelease(path, manifest);
    if (activeVersion(wrangler, true) !== current)
      throw new Error('Active version changed during migration checks; deployment stopped.');
    const result = wrangler([
      'deploy',
      '--tag',
      manifest.tree.slice(0, 16),
      '--message',
      `revision=${manifest.revision} tree=${manifest.tree}`,
      '--var',
      `RELEASE_SHA:${manifest.revision}`,
      '--var',
      `RELEASE_TREE:${manifest.tree}`,
    ]);
    requireSuccess(result, 'Deploy prepared release');
    const version = activeVersion(wrangler);
    if (!version) throw new Error('Cannot identify the deployed version.');
    manifest.version = version;
    saveRelease(path, manifest);
    await smoke(manifest);
    manifest.phase = 'verified';
    saveRelease(path, manifest);
    console.log(`Verified ${target.origin} version=${version} release=${path}`);
  } catch (error) {
    manifest.phase = 'failed';
    saveRelease(path, manifest);
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const options = parseDeployOptions(argv, process.env.ENVIRONMENT);
  let target = loadTarget(repo, options.environment, options.bootstrap);
  assertAccount(target, process.env.CLOUDFLARE_ACCOUNT_ID);
  assertIsolation(repo, target);
  const releaseLock = acquireDeployLock(repo, target);
  try {
    let wrangler = createWrangler(repo, target);
    if (options.bootstrap || options.secret) {
      if (options.dryRun) {
        console.log(
          `Plan only: ${options.bootstrap ? 'bootstrap' : `rotate ${options.secret}`} for ${target.worker} in account ${target.accountId}`,
        );
        return;
      }
      assertMembership(wrangler, target);
      if (options.bootstrap) {
        provisionSecretStore(wrangler, target);
        ensureResources(wrangler, target, true);
        target = loadTarget(repo, options.environment);
        assertIsolation(repo, target);
        wrangler = createWrangler(repo, target);
        createMissingSecrets(repo, wrangler, target);
        console.log('Bootstrap complete. Existing secrets were preserved.');
      } else if (options.secret) rotateSecret(repo, wrangler, target, options.secret);
      return;
    }
    const release = options.prepared
      ? {
          path: resolve(repo, options.prepared),
          manifest: loadPreparedRelease(repo, target, resolve(repo, options.prepared)),
        }
      : prepareRelease(repo, target, wrangler);
    if (options.dryRun) return;
    await publishRelease(repo, target, release.path, release.manifest, wrangler);
  } finally {
    releaseLock();
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Deployment failed.');
    process.exitCode = 1;
  });
}
