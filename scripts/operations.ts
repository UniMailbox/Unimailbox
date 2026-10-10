#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { environment, loadTarget } from '#scripts/deployment-config';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--environment')
  throw new Error('Usage: pnpm ops:check --environment staging|production');
const target = loadTarget(repo, environment(argv[1]));
for (const path of ['/readyz', '/healthz/maintenance']) {
  const response = await fetch(`${target.origin}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'UniMailbox-Deploy/1.0', 'Cache-Control': 'no-cache' },
  });
  const body: unknown = await response.json();
  if (!response.ok || !body || typeof body !== 'object' || !('ok' in body) || body.ok !== true)
    throw new Error(
      `Operations check failed at ${target.origin}${path}. Inspect cron.complete, D1 outbox age and the DLQ.`,
    );
  console.log(`Healthy: ${target.origin}${path}`);
}
