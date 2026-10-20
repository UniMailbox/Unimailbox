import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
  resetAndMigrate,
  seedInstallationState,
  seedResourceUsageActor,
} from '@unimailbox/test-kit';
import { resourceUsageResponseSchema } from '@unimailbox/contracts';
describe('R-ANALYTICS-001 resource dashboard authorization', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });
  it('requires authentication', async () => {
    expect((await SELF.fetch('https://example.test/api/v1/admin/resource-usage')).status).toBe(401);
  });
  it('denies a signed-in member without analytics.read', async () => {
    const token = await seedResourceUsageActor(false, env.CACHE);
    expect(
      (
        await SELF.fetch('https://example.test/api/v1/admin/resource-usage', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });
  it('returns explicit unconfigured state without disclosing mail or resource identities', async () => {
    const token = await seedResourceUsageActor(true, env.CACHE);
    const response = await SELF.fetch('https://example.test/api/v1/admin/resource-usage?days=30', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json<{ data: unknown }>();
    const data = resourceUsageResponseSchema.parse(body.data);
    expect(data.days).toBe(30);
    expect(data.services.every((s) => s.status === 'not_configured')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('owner@example.test');
  });
  it('rejects unsupported ranges and client-supplied account scopes', async () => {
    const token = await seedResourceUsageActor(true, env.CACHE);
    for (const query of ['days=90', 'days=0', 'days=7&accountId=other'])
      expect(
        (
          await SELF.fetch(`https://example.test/api/v1/admin/resource-usage?${query}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
  });
});
