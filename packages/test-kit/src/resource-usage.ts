import type { ResourceUsageResponse, MailProcessingResponse } from '@unimailbox/contracts';
export const ANALYTICS_CONFIG_FIXTURE = {
  accountId: 'a'.repeat(32),
  workerName: 'synthetic-mail-worker',
  d1DatabaseId: 'd0000000-0000-4000-8000-000000000001',
  kvNamespaceIds: ['b'.repeat(32), 'c'.repeat(32)],
  r2BucketName: 'synthetic-mail-bucket',
  queueId: 'd'.repeat(32),
};

export function mailProcessingFixture(days: 7 | 30 = 7): MailProcessingResponse {
  const base = resourceUsageFixture(days);
  const points = base.services[0]?.metrics[0]?.points ?? [];
  return {
    source: 'application_metadata',
    generatedAt: base.generatedAt,
    startDate: base.startDate,
    endDate: base.endDate,
    days,
    groups: [
      {
        id: 'mail',
        status: 'ready',
        metrics: [
          {
            id: 'received',
            label: 'Retained inbound messages',
            unit: 'count',
            aggregation: 'sum',
            points: points.map((p) => ({ ...p, value: p.value === null ? 0 : p.value / 120 })),
          },
        ],
      },
      {
        id: 'attachments',
        status: 'ready',
        metrics: [
          {
            id: 'inbound_bytes',
            label: 'Decoded inbound attachment bytes',
            unit: 'bytes',
            aggregation: 'sum',
            points: points.map((p) => ({ ...p, value: (p.value ?? 0) * 1024 })),
          },
        ],
      },
      {
        id: 'outbound',
        status: 'ready',
        metrics: [
          {
            id: 'latency',
            label: 'Created-to-sent latency',
            unit: 'milliseconds',
            aggregation: 'average',
            points: points.map((p, i) => ({ ...p, value: (i + 1) * 1000, sampleCount: i + 1 })),
          },
          {
            id: 'failed',
            label: 'Currently failed outbound tasks',
            unit: 'count',
            aggregation: 'sum',
            points: points.map((p, i) => ({ ...p, value: i % 3 === 0 ? 1 : 0 })),
          },
        ],
      },
      {
        id: 'receipts',
        status: 'ready',
        metrics: [
          {
            id: 'raw_max',
            label: 'Largest raw email sample',
            unit: 'bytes',
            aggregation: 'max',
            points: points.map((p, i) => ({ ...p, value: i === days - 1 ? 26214400 : null })),
          },
        ],
      },
    ],
  };
}
export function resourceUsageFixture(days: 7 | 30 = 7): ResourceUsageResponse {
  const points = Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.parse('2026-10-16T00:00:00Z') - (days - i - 1) * 86400_000)
      .toISOString()
      .slice(0, 10),
    value: i === 0 ? null : (i + 1) * 120,
  }));
  return {
    source: 'cloudflare',
    generatedAt: '2026-10-16T08:00:00Z',
    startDate: points[0]?.date ?? '',
    endDate: '2026-10-16',
    days,
    services: [
      {
        service: 'workers',
        status: 'ready',
        metrics: [
          { id: 'requests', label: 'Worker requests', unit: 'count', aggregation: 'sum', points },
          {
            id: 'errors',
            label: 'Worker errors',
            unit: 'count',
            aggregation: 'sum',
            points: points.map((p) => ({ ...p, value: p.value === null ? null : 0 })),
          },
        ],
      },
      {
        service: 'd1',
        status: 'ready',
        metrics: [
          { id: 'rowsRead', label: 'D1 rows read', unit: 'count', aggregation: 'sum', points },
        ],
      },
      { service: 'kv', status: 'forbidden', metrics: [] },
      {
        service: 'r2',
        status: 'ready',
        metrics: [
          {
            id: 'storage',
            label: 'R2 stored bytes',
            unit: 'bytes',
            aggregation: 'max',
            points: points.map((p) => ({ ...p, value: p.value === null ? null : p.value * 1024 })),
          },
        ],
      },
      { service: 'queues', status: 'not_configured', metrics: [] },
    ],
  };
}
