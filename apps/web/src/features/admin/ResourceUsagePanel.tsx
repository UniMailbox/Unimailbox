import { useId, useState } from 'react';
import { Activity, Database, HardDrive, Layers, ListOrdered, RefreshCw } from 'lucide-react';
import type { ResourceService } from '@unimailbox/contracts';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { useLanguage, useT } from '../../infrastructure/i18n/locale';
import { ApiError } from '../../infrastructure/api/errors';
import { resourceUsageQuery } from './resource-usage-queries';
import { UsageChart, summarize, formatValue } from './ResourceMetricChart';

const services = [
  { id: 'workers', label: 'Workers', icon: Activity },
  { id: 'd1', label: 'D1', icon: Database },
  { id: 'kv', label: 'KV', icon: Layers },
  { id: 'r2', label: 'R2', icon: HardDrive },
  { id: 'queues', label: 'Queue', icon: ListOrdered },
] as const;

export function ResourceUsagePanel() {
  const t = useT();
  const locale = useLanguage();
  const [days, setDays] = useState<7 | 30>(7);
  const [service, setService] = useState<ResourceService>('workers');
  const [metricId, setMetricId] = useState('requests');
  const panelId = useId();
  const query = resourceUsageQuery(days);
  const result = query.data?.services.find((item) => item.service === service);
  const selected = result?.metrics.find((item) => item.id === metricId) ?? result?.metrics[0];
  const forbidden = query.error instanceof ApiError && [401, 403].includes(query.error.status);
  return (
    <Card
      title={t('Cloudflare platform usage')}
      description={t('Cloudflare Analytics · Installation resources · UTC')}
      testId="resource-usage"
    >
      <div className="usage-toolbar">
        <div className="usage-range" role="group" aria-label={t('Usage date range')}>
          {([7, 30] as const).map((range) => (
            <Button
              key={range}
              size="sm"
              variant={days === range ? 'primary' : 'ghost'}
              aria-pressed={days === range}
              onClick={() => setDays(range)}
            >
              {t('Last {days} days', { days: range })}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {t('Refresh usage')}
        </Button>
      </div>
      <div className="usage-services" role="group" aria-label={t('Resource type')}>
        {services.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={item.id === service}
            aria-controls={panelId}
            onClick={() => {
              setService(item.id);
              setMetricId('');
            }}
          >
            <item.icon size={16} aria-hidden="true" />
            {item.label}
          </button>
        ))}
      </div>
      <div id={panelId} aria-busy={query.isFetching}>
        {query.isPending ? (
          <div className="usage-loading" role="status">
            {t('Loading resource usage…')}
            <div />
            <div />
            <div />
          </div>
        ) : null}
        {query.isError ? (
          forbidden ? (
            <p className="usage-empty" role="status">
              {t('You do not have permission to view resource usage.')}
            </p>
          ) : (
            <ErrorPanel
              message={t('Resource usage unavailable.')}
              onRetry={() => void query.refetch()}
              testId="resource-usage-error"
            />
          )
        ) : null}
        {query.data && result && !forbidden ? (
          <>
            {result.status === 'ready' && selected ? (
              <>
                <div className="usage-workspace">
                  <div className="usage-metrics" role="group" aria-label={t('Usage metric')}>
                    {result.metrics.map((metric) => (
                      <button
                        type="button"
                        key={metric.id}
                        aria-pressed={metric.id === selected.id}
                        onClick={() => setMetricId(metric.id)}
                      >
                        <span>{t(metric.label)}</span>
                        <strong>{formatValue(summarize(metric), metric.unit, locale)}</strong>
                        <small>
                          {t(
                            metric.aggregation === 'sum'
                              ? 'Recorded period total'
                              : 'Period maximum',
                          )}
                        </small>
                      </button>
                    ))}
                  </div>
                  <UsageChart key={`${service}-${days}-${selected.id}`} metric={selected} />
                </div>
                <details className="usage-data">
                  <summary>{t('View daily values')}</summary>
                  <table>
                    <caption>{t(selected.label)} · UTC</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('Date')}</th>
                        <th scope="col">{t('Usage')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.points.map((point) => (
                        <tr key={point.date}>
                          <th scope="row">{point.date}</th>
                          <td>{formatValue(point.value, selected.unit, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </>
            ) : (
              <div className="usage-empty" role="status">
                <Activity className="usage-empty-icon" size={24} aria-hidden="true" />
                <h3>
                  {t(
                    result.status === 'not_configured'
                      ? 'Connect resource analytics'
                      : result.status === 'forbidden'
                        ? 'Analytics access denied'
                        : 'Resource data unavailable',
                  )}
                </h3>
                <p>
                  {t(
                    result.status === 'not_configured'
                      ? 'Configure a read-only Cloudflare Analytics token and this installation’s resource IDs on the server.'
                      : result.status === 'forbidden'
                        ? 'Check the analytics token’s read permission and account scope.'
                        : 'Check the analytics configuration, token permissions and supported date range, then try again.',
                  )}
                </p>
                <a
                  href="https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('Analytics setup guide')}
                </a>
              </div>
            )}
            <p className="usage-footnote">
              {t(
                'Daily aggregates may be sampled or delayed. Today is incomplete. Missing values are not zero. This is not a billing statement or an account quota.',
              )}
            </p>
            <p className="usage-updated">
              {t('Checked at')}{' '}
              {new Date(query.data.generatedAt).toLocaleString(
                locale === 'zh-CN' ? 'zh-CN' : 'en-US',
              )}{' '}
              · {t('Cached for up to 5 minutes. No automatic polling.')}
            </p>
          </>
        ) : null}
      </div>
    </Card>
  );
}

export { summarize, formatValue } from './ResourceMetricChart';
