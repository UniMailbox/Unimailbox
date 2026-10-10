import type { ReleaseManifest } from '#scripts/deployment-release';

export async function smokeRelease(
  manifest: ReleaseManifest,
  request: typeof fetch = fetch,
): Promise<void> {
  const get = (path: string): Promise<Response> =>
    request(`${manifest.origin}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'UniMailbox-Deploy/1.0', 'Cache-Control': 'no-cache' },
    });
  const health = await get('/healthz');
  const body = (await health.json()) as { ok?: unknown; version?: unknown; tree?: unknown };
  if (
    !health.ok ||
    body.ok !== true ||
    body.version !== manifest.version ||
    body.tree !== manifest.tree
  )
    throw new Error('Deployed version/health does not match the prepared release.');
  const ready = await get('/readyz');
  const readiness = (await ready.json()) as { ok?: unknown; schema?: unknown };
  if (
    !ready.ok ||
    readiness.ok !== true ||
    readiness.schema !== Object.keys(manifest.migrations).at(-1)?.slice(0, 4)
  )
    throw new Error('Deployment dependencies/schema are not ready.');
  const page = await get('/login');
  const html = await page.text();
  if (!page.ok || !html.includes(manifest.entry) || !page.headers.get('Content-Security-Policy'))
    throw new Error('Frontend entry or security headers do not match the release.');
  const asset = await get(manifest.entry);
  if (
    !asset.ok ||
    !/javascript/.test(asset.headers.get('Content-Type') ?? '') ||
    !/immutable/.test(asset.headers.get('Cache-Control') ?? '')
  )
    throw new Error('Hashed frontend asset is missing or uncached.');
  await asset.body?.cancel();
  for (const path of [`${manifest.entry}.map`, '/assets/deploy-smoke-missing.js', '/api']) {
    const response = await get(path);
    if (response.status !== 404) throw new Error(`Expected 404 for ${path}.`);
    await response.body?.cancel();
  }
  const protectedRoute = await get('/api/v1/admin/overview');
  const error = (await protectedRoute.json()) as { error?: { code?: unknown } };
  if (protectedRoute.status !== 401 || error.error?.code !== 'AUTHENTICATION_REQUIRED')
    throw new Error('Protected API authentication smoke failed.');
}

/** Allow bounded edge propagation; a persistent failure still fails publication. */
export async function verifyPublishedRelease(manifest: ReleaseManifest): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await smokeRelease(manifest);
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      console.log(`Waiting for release propagation (${attempt + 1}/5).`);
      await new Promise((done) => setTimeout(done, Math.min(2 ** attempt, 8) * 1000));
    }
  }
}
