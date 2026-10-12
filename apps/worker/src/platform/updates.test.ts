import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPSTREAM_REPOSITORY } from '@unimailbox/contracts';
import { fetchLatestRelease } from './updates';

const release = {
  tag_name: 'v1.10.0',
  published_at: '2026-10-12T00:00:00Z',
  draft: false,
  prerelease: false,
};
afterEach(() => vi.useRealTimers());

describe('anonymous upstream release fetch', () => {
  it('uses a fixed public endpoint and passes no installation information', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...release,
        html_url: 'https://attacker.example',
        body: '<script>evil()</script>',
      }),
    );
    expect(await fetchLatestRelease(fetchImpl)).toEqual({
      tag: 'v1.10.0',
      publishedAt: release.published_at,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/latest`);
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(Object.keys(Object.fromEntries(new Headers(init?.headers)))).toEqual([
      'accept',
      'user-agent',
      'x-github-api-version',
    ]);
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined();
  });
  it('distinguishes absent releases from rate limits and invalid payloads', async () => {
    expect(await fetchLatestRelease(async () => new Response(null, { status: 404 }))).toBeNull();
    for (const response of [
      new Response(null, { status: 403 }),
      new Response(null, { status: 429 }),
      Response.json({ ...release, draft: true }),
      Response.json({ ...release, prerelease: true }),
      Response.json({ ...release, tag_name: 'v1.0.0-beta' }),
      new Response('not JSON'),
    ])
      await expect(fetchLatestRelease(async () => response)).rejects.toThrow();
  });
  it('bounds response bytes and cancels an oversized stream', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
      cancel,
    });
    await expect(fetchLatestRelease(async () => new Response(body))).rejects.toThrow('too large');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts a stalled upstream request after five seconds', async () => {
    vi.useFakeTimers();
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const check = expect(fetchLatestRelease(fetchImpl)).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(5000);
    await check;
  });
});
