import { z } from 'zod';
import {
  resourceMetricSchema,
  type ResourceMetric,
  type ResourceService,
  type ResourceUsageReader,
  type ResourceUsageResponse,
} from '@unimailbox/contracts';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const CACHE_SECONDS = 300;
const ROW_LIMIT = 1000;
const configSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/i),
    workerName: z.string().min(1).max(128).optional(),
    d1DatabaseId: z.string().uuid().optional(),
    kvNamespaceIds: z
      .array(z.string().regex(/^[a-f0-9]{32}$/i))
      .min(1)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    r2BucketName: z.string().min(1).max(128).optional(),
    queueId: z
      .string()
      .regex(/^[a-f0-9]{32}$/i)
      .optional(),
  })
  .strict();
type Config = z.infer<typeof configSchema>;
type ServiceResult = ResourceUsageResponse['services'][number];
type MetricSpec = {
  id: string;
  label: string;
  unit?: ResourceMetric['unit'];
  aggregation?: 'max';
  dataset: string;
  field: string;
  action?: string;
};
const specs: Record<ResourceService, MetricSpec[]> = {
  workers: [
    { id: 'requests', label: 'Worker requests', dataset: 'usage', field: 'requests' },
    { id: 'errors', label: 'Worker errors', dataset: 'usage', field: 'errors' },
    { id: 'subrequests', label: 'Worker subrequests', dataset: 'usage', field: 'subrequests' },
  ],
  d1: [
    { id: 'rowsRead', label: 'D1 rows read', dataset: 'usage', field: 'rowsRead' },
    { id: 'rowsWritten', label: 'D1 rows written', dataset: 'usage', field: 'rowsWritten' },
    { id: 'readQueries', label: 'D1 read queries', dataset: 'usage', field: 'readQueries' },
    { id: 'writeQueries', label: 'D1 write queries', dataset: 'usage', field: 'writeQueries' },
  ],
  kv: ['read', 'write', 'delete', 'list'].map((action) => ({
    id: action,
    label: `KV ${action} operations`,
    dataset: 'usage',
    field: 'requests',
    action,
  })),
  r2: [
    { id: 'requests', label: 'R2 operations', dataset: 'usage', field: 'requests' },
    {
      id: 'storage',
      label: 'R2 stored bytes',
      dataset: 'storage',
      field: 'payloadSize',
      unit: 'bytes',
      aggregation: 'max',
    },
    {
      id: 'objects',
      label: 'R2 stored objects',
      dataset: 'storage',
      field: 'objectCount',
      aggregation: 'max',
    },
  ],
  queues: [
    { id: 'operations', label: 'Queue message operations', dataset: 'usage', field: 'count' },
    {
      id: 'bytes',
      label: 'Queue processed bytes',
      dataset: 'usage',
      field: 'bytes',
      unit: 'bytes',
    },
  ],
};
const services = Object.keys(specs) as ResourceService[];
interface SnapshotCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
class AnalyticsError extends Error {
  constructor(readonly forbidden = false) {
    super('Analytics unavailable');
  }
}

/** No deployment credentials, account-wide fallback, mail bodies or telemetry writes. */
export function createResourceUsageReader(options: {
  config?: string;
  token?: () => Promise<string>;
  fetch?: typeof fetch;
  cache?: SnapshotCache;
}): ResourceUsageReader {
  return {
    async read(days, now) {
      const endDate = now.toISOString().slice(0, 10);
      const start = new Date(`${endDate}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - days + 1);
      const startDate = start.toISOString().slice(0, 10);
      const dates = Array.from({ length: days }, (_, i) =>
        new Date(start.getTime() + i * 86400_000).toISOString().slice(0, 10),
      );
      const base = {
        source: 'cloudflare' as const,
        generatedAt: now.toISOString(),
        startDate,
        endDate,
        days,
      };
      let config: Config;
      try {
        config = configSchema.parse(JSON.parse(options.config ?? '{}'));
      } catch {
        return {
          ...base,
          services: services.map((service) => ({
            service,
            status: options.config ? 'unavailable' : 'not_configured',
            metrics: [],
          })),
        };
      }
      if (!options.token)
        return {
          ...base,
          services: services.map((service) => ({ service, status: 'not_configured', metrics: [] })),
        };
      let token: string;
      try {
        token = await options.token();
        if (!token.trim()) throw new Error();
      } catch {
        return {
          ...base,
          services: services.map((service) => ({ service, status: 'unavailable', metrics: [] })),
        };
      }
      // Credential rotation and different installation resources cannot reuse a snapshot.
      const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(config) + '\n' + token),
      );
      const scope = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      const results = await Promise.all(
        services.map(async (service): Promise<ServiceResult> => {
          const query = buildQuery(service, config, startDate, endDate, now);
          if (!query) return { service, status: 'not_configured', metrics: [] };
          const cacheKey = new Request(
            `https://resource-analytics.invalid/${scope}/${service}/${startDate}/${endDate}`,
          );
          try {
            const cached = await options.cache?.match(cacheKey);
            if (cached) {
              const metrics = z
                .array(resourceMetricSchema)
                .max(8)
                .parse(await cached.json());
              return { service, status: 'ready', metrics };
            }
          } catch {
            /* A cache failure must not prevent a bounded provider read. */
          }
          try {
            const account = await readAccount(options.fetch ?? fetch, token, query);
            const metrics = normalize(service, account, dates, config.kvNamespaceIds?.length ?? 0);
            try {
              await options.cache?.put(
                cacheKey,
                new Response(JSON.stringify(metrics), {
                  headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
                  },
                }),
              );
            } catch {
              /* The response remains usable when optional caching fails. */
            }
            return { service, status: 'ready', metrics };
          } catch (error) {
            return {
              service,
              status:
                error instanceof AnalyticsError && error.forbidden ? 'forbidden' : 'unavailable',
              metrics: [],
            };
          }
        }),
      );
      return { ...base, services: results };
    },
  };
}

function buildQuery(
  service: ResourceService,
  config: Config,
  start: string,
  end: string,
  now: Date,
) {
  const fields = {
    workers: config.workerName,
    d1: config.d1DatabaseId,
    kv: config.kvNamespaceIds,
    r2: config.r2BucketName,
    queues: config.queueId,
  };
  if (!fields[service]) return null;
  const time = `datetime_geq:${JSON.stringify(start + 'T00:00:00Z')},datetime_leq:${JSON.stringify(now.toISOString())}`;
  const date = `date_geq:${JSON.stringify(start)},date_leq:${JSON.stringify(end)}`;
  const dataset = (
    alias: string,
    name: string,
    filter: string,
    fields: string,
    dimensions = 'date',
  ) =>
    `${alias}:${name}(limit:${ROW_LIMIT},filter:{${filter}}){${fields} dimensions{${dimensions}}}`;
  let body: string;
  switch (service) {
    case 'workers':
      body = dataset(
        'usage',
        'workersInvocationsAdaptive',
        `${time},scriptName:${JSON.stringify(config.workerName)}`,
        'sum{requests errors subrequests}',
      );
      break;
    case 'd1':
      body = dataset(
        'usage',
        'd1AnalyticsAdaptiveGroups',
        `${date},databaseId:${JSON.stringify(config.d1DatabaseId)}`,
        'sum{rowsRead rowsWritten readQueries writeQueries}',
      );
      break;
    case 'kv':
      body = (config.kvNamespaceIds ?? [])
        .map((id, i) =>
          dataset(
            `usage${i}`,
            'kvOperationsAdaptiveGroups',
            `${date},namespaceId:${JSON.stringify(id)}`,
            'sum{requests}',
            'date actionType',
          ),
        )
        .join('\n');
      break;
    case 'r2':
      body =
        dataset(
          'usage',
          'r2OperationsAdaptiveGroups',
          `${time},bucketName:${JSON.stringify(config.r2BucketName)}`,
          'sum{requests}',
        ) +
        dataset(
          'storage',
          'r2StorageAdaptiveGroups',
          `${time},bucketName:${JSON.stringify(config.r2BucketName)}`,
          'max{payloadSize objectCount}',
        );
      break;
    case 'queues':
      body = dataset(
        'usage',
        'queueMessageOperationsAdaptiveGroups',
        `${time},queueId:${JSON.stringify(config.queueId)}`,
        'count sum{bytes}',
      );
      break;
  }
  return `{viewer{accounts(filter:{accountTag:${JSON.stringify(config.accountId)}}){${body}}}}`;
}

async function readAccount(
  fetcher: typeof fetch,
  token: string,
  query: string,
): Promise<Record<string, unknown>> {
  const response = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AnalyticsError(response.status === 401 || response.status === 403);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AnalyticsError();
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 524288) {
        await reader.cancel().catch(() => {});
        throw new AnalyticsError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const payload = z
    .object({
      errors: z.array(z.unknown()).nullish(),
      data: z
        .object({ viewer: z.object({ accounts: z.array(z.record(z.unknown())).length(1) }) })
        .nullish(),
    })
    .parse(JSON.parse(text));
  if (payload.errors?.length || !payload.data) throw new AnalyticsError();
  const account = payload.data.viewer.accounts[0];
  if (!account) throw new AnalyticsError();
  return account;
}

function normalize(
  service: ResourceService,
  account: Record<string, unknown>,
  dates: string[],
  kvNamespaces: number,
): ResourceMetric[] {
  const rowsSchema = z
    .array(
      z.object({
        dimensions: z.object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          actionType: z.string().optional(),
        }),
        sum: z.record(z.number().finite().nonnegative()).optional(),
        max: z.record(z.number().finite().nonnegative()).optional(),
        count: z.number().finite().nonnegative().optional(),
      }),
    )
    .max(ROW_LIMIT - 1);
  // Hitting the limit could mean truncation. Never present truncated totals.
  const datasets = new Map(
    Object.entries(account).map(([key, value]) => [key, rowsSchema.parse(value)]),
  );
  return specs[service].map((spec) => {
    const keys =
      service === 'kv'
        ? Array.from({ length: kvNamespaces }, (_, index) => `usage${index}`)
        : [spec.dataset];
    if (!keys.length || keys.some((key) => !datasets.has(key))) throw new AnalyticsError();
    const points = new Map<string, number>();
    for (const key of keys)
      for (const row of datasets.get(key) ?? []) {
        if (
          !dates.includes(row.dimensions.date) ||
          (spec.action && row.dimensions.actionType !== spec.action)
        )
          continue;
        const value =
          spec.field === 'count'
            ? row.count
            : (spec.aggregation === 'max' ? row.max : row.sum)?.[spec.field];
        if (value === undefined) throw new AnalyticsError();
        const old = points.get(row.dimensions.date);
        points.set(
          row.dimensions.date,
          spec.aggregation === 'max' ? Math.max(old ?? 0, value) : (old ?? 0) + value,
        );
      }
    return {
      id: spec.id,
      label: spec.label,
      unit: spec.unit ?? 'count',
      aggregation: spec.aggregation ?? 'sum',
      points: dates.map((date) => ({ date, value: points.get(date) ?? null })),
    };
  });
}
