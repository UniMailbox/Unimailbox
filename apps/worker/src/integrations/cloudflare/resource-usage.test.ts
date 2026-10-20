import { describe, expect, it, vi } from 'vitest';
import { ANALYTICS_CONFIG_FIXTURE as config } from '@unimailbox/test-kit/resource-usage';
import { createResourceUsageReader } from './resource-usage';
const now = new Date('2026-10-16T08:00:00Z');
const row = (sum: Record<string, number>, actionType?: string) => ({
  dimensions: { date: '2026-10-16', ...(actionType ? { actionType } : {}) },
  sum,
});
const response = (account: unknown) => Response.json({ data: { viewer: { accounts: [account] } } });
const reader = (fetcher: typeof fetch, override = {}) =>
  createResourceUsageReader({
    config: JSON.stringify({ ...config, ...override }),
    token: async () => 'synthetic-read-only-token',
    fetch: fetcher,
  });
describe('R-ANALYTICS-001/002 resource analytics', () => {
  it('never falls back to account-wide queries when resources or credentials are absent', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (await createResourceUsageReader({ fetch: fetcher }).read(7, now)).services.every(
        (s) => s.status === 'not_configured',
      ),
    ).toBe(true);
    const accountOnly = createResourceUsageReader({
      config: JSON.stringify({ accountId: config.accountId }),
      token: async () => 'fixture',
      fetch: fetcher,
    });
    expect(
      (await accountOnly.read(7, now)).services.every((s) => s.status === 'not_configured'),
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses explicit resource filters, sums counters, preserves missing days and takes storage maxima', async () => {
    const queries: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe('error');
      const query = JSON.parse(String(init?.body)).query as string;
      queries.push(query);
      if (query.includes('workersInvocations'))
        return response({ usage: [row({ requests: 15, errors: 0, subrequests: 6 })] });
      if (query.includes('d1Analytics'))
        return response({
          usage: [row({ rowsRead: 123, rowsWritten: 4, readQueries: 2, writeQueries: 1 })],
        });
      if (query.includes('kvOperations'))
        return response({
          usage0: [row({ requests: 10 }, 'read')],
          usage1: [row({ requests: 20 }, 'read')],
        });
      if (query.includes('r2Operations'))
        return response({
          usage: [row({ requests: 5 })],
          storage: [200, 100].map((value) => ({
            dimensions: { date: '2026-10-16' },
            max: { payloadSize: value, objectCount: 3 },
          })),
        });
      return response({ usage: [{ ...row({ bytes: 512 }), count: 8 }] });
    });
    const data = await reader(fetcher).read(7, now);
    expect(data.services.every((s) => s.status === 'ready')).toBe(true);
    expect(queries).toHaveLength(5);
    for (const query of queries) expect(query).toContain(config.accountId);
    for (const value of [
      config.workerName,
      config.d1DatabaseId,
      ...config.kvNamespaceIds,
      config.r2BucketName,
      config.queueId,
    ])
      expect(queries.join('\n')).toContain(value);
    expect(data.services[2]?.metrics[0]?.points.at(-1)?.value).toBe(30);
    expect(data.services[3]?.metrics[1]?.points.at(-1)?.value).toBe(200);
    expect(data.services[0]?.metrics[0]?.points[0]?.value).toBeNull();
    expect(JSON.stringify(data)).not.toContain('synthetic-read-only-token');
    expect(JSON.stringify(data)).not.toContain(config.accountId);
  });
  it('isolates forbidden and GraphQL failures without disclosing provider diagnostics', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const query = String(init?.body);
      if (query.includes('workersInvocations'))
        return new Response('private-diagnostic', { status: 403 });
      if (query.includes('d1Analytics'))
        return Response.json({ errors: [{ message: 'private-diagnostic' }] });
      if (query.includes('kvOperations')) return response({ usage0: [], usage1: [] });
      if (query.includes('r2Operations')) return response({ usage: [], storage: [] });
      throw new Error('private-diagnostic');
    });
    const data = await reader(fetcher).read(30, now);
    expect(data.services.map((s) => s.status)).toEqual([
      'forbidden',
      'unavailable',
      'ready',
      'ready',
      'unavailable',
    ]);
    expect(data.services[2]?.metrics[0]?.points).toHaveLength(30);
    expect(JSON.stringify(data)).not.toContain('private-diagnostic');
  });
  it.each(['oversized', 'truncated', 'malformed', 'negative', 'missing_dataset'])(
    'rejects %s responses rather than reporting fabricated totals',
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (mode === 'oversized') return new Response('x'.repeat(524289));
        if (mode === 'malformed') return new Response('not-json');
        if (mode === 'missing_dataset') return response({});
        return response({
          usage: Array.from({ length: mode === 'truncated' ? 1000 : 1 }, () =>
            row({ requests: mode === 'negative' ? -1 : 1, errors: 0, subrequests: 0 }),
          ),
        });
      });
      expect((await reader(fetcher).read(7, now)).services[0]?.status).toBe('unavailable');
    },
  );
  it('separates cached snapshots by resources, windows and credential rotation', async () => {
    const saved = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => saved.get(request.url)?.clone(),
      put: async (request: Request, value: Response) => {
        saved.set(request.url, value.clone());
      },
    };
    const fetcher = vi.fn<typeof fetch>(async () => response({ usage: [] }));
    const make = (token: string, workerName = config.workerName) =>
      createResourceUsageReader({
        config: JSON.stringify({ accountId: config.accountId, workerName }),
        token: async () => token,
        fetch: fetcher,
        cache,
      });
    await make('token-a').read(7, now);
    await make('token-a').read(7, now);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await make('token-b').read(7, now);
    await make('token-a', 'another-worker').read(7, now);
    await make('token-a').read(30, now);
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const key of saved.keys()) expect(key).not.toContain('token-');
  });
  it('rejects duplicate KV resources to prevent counting a namespace twice', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const data = await reader(fetcher, {
      kvNamespaceIds: [config.kvNamespaceIds[0], config.kvNamespaceIds[0]],
    }).read(7, now);
    expect(data.services.every((s) => s.status === 'unavailable')).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
