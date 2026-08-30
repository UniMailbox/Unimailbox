const DEFAULT_WORKER_TARGET = 'http://localhost:8787';

/**
 * Resolve the local Worker origin used by the Vite API proxy.
 *
 * This proxy forwards browser cookies and authorization headers, so a target
 * must be an explicitly trusted loopback origin rather than an arbitrary URL.
 * The origin-only result also prevents an accidental path/query from changing
 * the routing contract for `/api/*`.
 */
export function resolveWorkerProxyTarget(raw: string | undefined): string {
  const candidate = raw?.trim() || DEFAULT_WORKER_TARGET;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('VITE_WORKER_URL must be a valid local http(s) origin');
  }

  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !loopbackHosts.has(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('VITE_WORKER_URL must be a valid local http(s) origin');
  }

  return parsed.origin;
}
