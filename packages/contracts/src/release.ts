import { z } from 'zod';

// Product version, independent of Cloudflare's Worker version UUID. Bump before
// tagging a stable release; 0.0.0 denotes the development baseline.
export const APPLICATION_VERSION = '1.0.2';
export const UPSTREAM_REPOSITORY = 'UniMailbox/Unimailbox';
export const UPSTREAM_URL = `https://github.com/${UPSTREAM_REPOSITORY}`;
export const UPGRADE_GUIDE_URL = `${UPSTREAM_URL}/blob/main/docs/operations/updates.md`;

export const releaseVersionSchema = z
  .string()
  .max(64)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const releaseTagSchema = z
  .string()
  .max(65)
  .refine((tag) => tag.startsWith('v') && releaseVersionSchema.safeParse(tag.slice(1)).success);

export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1 {
  const a = releaseVersionSchema.parse(left).split('.').map(BigInt) as [bigint, bigint, bigint];
  const b = releaseVersionSchema.parse(right).split('.').map(BigInt) as [bigint, bigint, bigint];
  for (const index of [0, 1, 2] as const) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

export const upstreamReleaseSchema = z
  .object({ tag: releaseTagSchema, publishedAt: z.string().datetime({ offset: true }) })
  .strict();
export const updateCheckResponseSchema = z
  .object({
    current: z.object({ version: releaseVersionSchema, revision: z.string().max(128) }).strict(),
    status: z.enum(['available', 'current', 'ahead', 'no_release', 'unavailable', 'disabled']),
    latest: upstreamReleaseSchema.nullable(),
    checkedAt: z.string().datetime().nullable(),
  })
  .strict();
export type UpstreamRelease = z.infer<typeof upstreamReleaseSchema>;
export type UpdateCheckResponse = z.infer<typeof updateCheckResponseSchema>;
