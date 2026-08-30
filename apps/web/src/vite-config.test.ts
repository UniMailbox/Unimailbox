import { describe, expect, it } from 'vitest';
import { resolveWorkerProxyTarget } from './vite-proxy';

describe('Vite local Worker proxy target', () => {
  it('uses the local Wrangler port by default', () => {
    expect(resolveWorkerProxyTarget(undefined)).toBe('http://localhost:8787');
  });

  it('accepts a trusted loopback origin and removes a trailing slash', () => {
    expect(resolveWorkerProxyTarget('http://127.0.0.1:8788/')).toBe('http://127.0.0.1:8788');
  });

  it.each([
    'https://example.test',
    'http://localhost:8787/api',
    'http://localhost:8787/?redirect=external',
    'http://user:password@localhost:8787',
    'ftp://localhost:8787',
  ])('rejects an untrusted or non-origin target: %s', (target) => {
    expect(() => resolveWorkerProxyTarget(target)).toThrow(
      'VITE_WORKER_URL must be a valid local http(s) origin',
    );
  });
});
