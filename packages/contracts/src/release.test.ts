import { describe, expect, it } from 'vitest';
import { compareReleaseVersions, releaseTagSchema, updateCheckResponseSchema } from './release';

describe('stable release identity', () => {
  it.each([
    ['1.10.0', '1.2.0', 1],
    ['1.0.1', '1.0.2', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.2.3', '1.2.3', 0],
    ['999999999999999999.0.0', '999999999999999998.0.0', 1],
  ])('compares %s and %s numerically', (left, right, comparison) => {
    expect(compareReleaseVersions(left, right)).toBe(comparison);
  });
  it.each(['v01.2.3', 'v1.2', 'v1.2.3-beta.1', 'v1.2.3+build', 'v1.2.3/<script>', '1.2.3'])(
    'rejects non-stable or unsafe tag %s',
    (tag) => {
      expect(releaseTagSchema.safeParse(tag).success).toBe(false);
    },
  );
  it('rejects upstream URLs and private fields in the returned projection', () => {
    expect(
      updateCheckResponseSchema.safeParse({
        current: { version: '1.0.0', revision: 'development' },
        status: 'available',
        latest: {
          tag: 'v1.1.0',
          publishedAt: '2026-10-12T00:00:00Z',
          html_url: 'https://attacker.example',
        },
        checkedAt: '2026-10-12T00:00:00Z',
      }).success,
    ).toBe(false);
  });
});
