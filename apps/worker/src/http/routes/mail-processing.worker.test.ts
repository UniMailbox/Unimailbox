import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
  resetAndMigrate,
  seedInstallationState,
  seedResourceUsageActor,
  seedMailProcessingMetrics,
} from '@unimailbox/test-kit';
import { mailProcessingResponseSchema } from '@unimailbox/contracts';
import { readMailProcessing } from '../../modules/admin';
import verification from '../../../../../migrations/0040_mail_analytics_indexes.verify.sql?raw';
const now = new Date('2026-10-16T12:00:00Z');
describe('R-ANALYTICS-001/003 mail processing metadata', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await seedInstallationState({ status: 'complete', currentStep: 'complete' });
  });
  it('requires both authentication and analytics permission', async () => {
    expect((await SELF.fetch('https://example.test/api/v1/admin/mail-processing')).status).toBe(
      401,
    );
    const token = await seedResourceUsageActor(false, env.CACHE);
    expect(
      (
        await SELF.fetch('https://example.test/api/v1/admin/mail-processing', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
  });
  it('aggregates metadata without multiplying attachments by jobs or exposing private fields', async () => {
    const token = await seedResourceUsageActor(true, env.CACHE);
    await seedMailProcessingMetrics();
    const response = await SELF.fetch('https://example.test/api/v1/admin/mail-processing?days=7', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { data } = await response.json<{ data: unknown }>();
    const parsed = mailProcessingResponseSchema.parse(data);
    expect(JSON.stringify(parsed)).not.toMatch(/private-|example.test|ciphertext|object_key/);
    const snapshot = await readMailProcessing(env.DB, 7, now);
    const point = (group: string, id: string, date = '2026-10-16') =>
      snapshot.groups
        .find((g) => g.id === group)
        ?.metrics.find((m) => m.id === id)
        ?.points.find((p) => p.date === date);
    expect(point('mail', 'received')?.value).toBe(1);
    expect(point('attachments', 'inbound_bytes')?.value).toBe(30);
    expect(point('attachments', 'inbound_count')?.value).toBe(2);
    expect(point('attachments', 'outbound_bytes', '2026-10-15')?.value).toBe(45);
    expect(point('attachments', 'hosted_bytes', '2026-10-15')?.value).toBe(64);
    expect(point('outbound', 'latency', '2026-10-15')).toMatchObject({
      value: 2000,
      sampleCount: 2,
    });
    expect(point('outbound', 'latency')).toMatchObject({ value: 9000, sampleCount: 1 });
    expect(point('outbound', 'failed')?.value).toBe(1);
    expect(point('outbound', 'unknown')?.value).toBe(1);
    expect(point('outbound', 'retries')?.value).toBe(3);
    expect(point('receipts', 'raw_max')?.value).toBe(26214400);
    expect(point('receipts', 'latency')).toMatchObject({ value: 4000, sampleCount: 1 });
    expect(point('receipts', 'raw_bytes', '2026-10-15')?.value).toBeNull();
  });
  it('keeps receipt expiry distinct from zero and leaves retained message/attachment counts intact', async () => {
    await seedResourceUsageActor(true, env.CACHE);
    await seedMailProcessingMetrics();
    await env.DB.prepare('DELETE FROM inbound_receipts').run();
    const data = await readMailProcessing(env.DB, 30, now);
    expect(data.groups[3]?.metrics.every((m) => m.points.every((p) => p.value === null))).toBe(
      true,
    );
    expect(data.groups[0]?.metrics[0]?.points.at(-1)?.value).toBe(1);
  });
  it('excludes out-of-window rows and invalid negative durations, using UTC boundaries for ISO/SQLite dates', async () => {
    await seedResourceUsageActor(true, env.CACHE);
    await seedMailProcessingMetrics();
    await env.DB.prepare(
      "UPDATE outbound_jobs SET updated_at='2020-01-01' WHERE status='sent'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO messages(id,from_address,raw_object_key,created_at) VALUES ('old','private@example.test','key','2026-10-09T23:59:59Z'),('future','private@example.test','key2','2026-10-17 00:00:00')",
    ).run();
    const data = await readMailProcessing(env.DB, 7, now);
    expect(data.startDate).toBe('2026-10-10');
    expect(data.groups[0]?.metrics[0]?.points.reduce((s, p) => s + (p.value ?? 0), 0)).toBe(1);
    expect(
      data.groups[2]?.metrics
        .find((m) => m.id === 'latency')
        ?.points.every((p) => p.value === null && p.sampleCount === 0),
    ).toBe(true);
  });
  it('rejects partial totals at the record cap and verifies migration indexes', async () => {
    await env.DB.exec(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO messages(id,from_address,created_at) SELECT 'bulk-'||x,'fixture@example.test','2026-10-16 00:00:00' FROM n;",
    );
    const data = await readMailProcessing(env.DB, 7, now);
    expect(
      data.groups.slice(0, 2).every((g) => g.status === 'limit_exceeded' && g.metrics.length === 0),
    ).toBe(true);
    for (const sql of verification.split(';').filter((s) => s.trim()))
      expect((await env.DB.prepare(sql).first<{ pass: number }>())?.pass).toBe(1);
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM outbound_jobs WHERE created_at>=? AND created_at<? ORDER BY created_at,id LIMIT 5001',
    )
      .bind('2026-10-10', '2026-10-17')
      .all();
    expect(JSON.stringify(plan)).toContain('outbound_jobs_created_at_idx');
  });
  it('rejects unsupported windows and mailbox filters instead of widening aggregate access', async () => {
    const token = await seedResourceUsageActor(true, env.CACHE);
    for (const query of ['days=90', 'days=7&mailboxId=other'])
      expect(
        (
          await SELF.fetch(`https://example.test/api/v1/admin/mail-processing?${query}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
  });
});
