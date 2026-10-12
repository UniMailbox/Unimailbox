import { z } from 'zod';
import {
  APPLICATION_VERSION,
  UPSTREAM_REPOSITORY,
  compareReleaseVersions,
  releaseTagSchema,
  upstreamReleaseSchema,
  type UpdateCheckResponse,
  type UpstreamRelease,
} from '@unimailbox/contracts';
import type { Env } from './env';
import { systemClock } from './clock';

export const UPDATE_CACHE_KEY = 'updates:github:stable:v1';
const SUCCESS_TTL_SECONDS = 6 * 60 * 60;
const FAILURE_TTL_SECONDS = 15 * 60;
const MAX_RESPONSE_BYTES = 256 * 1024;
const githubReleaseSchema = z.object({
  tag_name: releaseTagSchema,
  published_at: z.string().datetime({ offset: true }),
  draft: z.literal(false),
  prerelease: z.literal(false),
});
const cacheSchema = z
  .object({
    checkedAt: z.string().datetime(),
    expiresAt: z.number().int(),
    unavailable: z.boolean(),
    latest: upstreamReleaseSchema.nullable(),
  })
  .strict();

// Bound both bytes and time, including body reads. Neither release-note HTML
// nor an upstream-supplied URL crosses into the UI.
export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Unimailbox-update-check',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Release check unavailable');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error('Release response too large');
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel();
    }
    const release = githubReleaseSchema.parse(JSON.parse(body));
    return { tag: release.tag_name, publishedAt: release.published_at };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdates(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now = systemClock.unixMs(),
): Promise<UpdateCheckResponse> {
  const current = { version: APPLICATION_VERSION, revision: env.RELEASE_SHA ?? 'development' };
  const fallback = { current, latest: null, checkedAt: null };
  if (env.UPDATE_CHECK_ENABLED === 'false') return { ...fallback, status: 'disabled' };
  try {
    const cached = cacheSchema.safeParse(await env.CACHE.get(UPDATE_CACHE_KEY, 'json'));
    let result = cached.success && cached.data.expiresAt > now ? cached.data : null;
    if (result === null) {
      let latest: UpstreamRelease | null = null;
      let unavailable = false;
      try {
        latest = await fetchLatestRelease(fetchImpl);
      } catch {
        unavailable = true;
      }
      const ttl = unavailable ? FAILURE_TTL_SECONDS : SUCCESS_TTL_SECONDS;
      result = {
        latest,
        unavailable,
        checkedAt: new Date(now).toISOString(),
        expiresAt: now + ttl * 1000,
      };
      await env.CACHE.put(UPDATE_CACHE_KEY, JSON.stringify(result), { expirationTtl: ttl });
    }
    const comparison = result.latest
      ? compareReleaseVersions(result.latest.tag.slice(1), current.version)
      : 0;
    return {
      current,
      latest: result.latest,
      checkedAt: result.checkedAt,
      status: result.unavailable
        ? 'unavailable'
        : result.latest === null
          ? 'no_release'
          : comparison > 0
            ? 'available'
            : comparison < 0
              ? 'ahead'
              : 'current',
    };
  } catch {
    // KV/GitHub failure must never block administration or mail operations.
    return { ...fallback, status: 'unavailable' };
  }
}
