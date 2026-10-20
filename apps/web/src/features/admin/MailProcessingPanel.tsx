import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { useLanguage, useT } from '../../infrastructure/i18n/locale';
import { ApiError } from '../../infrastructure/api/errors';
import { UsageChart, summarize, formatValue } from './ResourceMetricChart';
import { mailProcessingQuery } from './mail-processing-queries';

const groups = [
  { id: 'mail', label: 'Mail volume' },
  { id: 'attachments', label: 'Attachments and hosted assets' },
  { id: 'outbound', label: 'Outbound processing' },
  { id: 'receipts', label: 'Retained receipt samples' },
] as const;
export function MailProcessingPanel() {
  const t = useT(),
    locale = useLanguage();
  const [days, setDays] = useState<7 | 30>(7);
  const [groupId, setGroupId] = useState('mail');
  const [metricId, setMetricId] = useState('');
  const query = mailProcessingQuery(days);
  const denied = query.error instanceof ApiError && [401, 403].includes(query.error.status);
  const group = query.data?.groups.find((item) => item.id === groupId);
  const metric = group?.metrics.find((item) => item.id === metricId) ?? group?.metrics[0];
  return (
    <Card
      title={t('Mail processing')}
      description={t('Application metadata · Retained records · UTC')}
      testId="mail-processing"
    >
      <div className="usage-toolbar">
        <div className="usage-range" role="group" aria-label={t('Mail processing date range')}>
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
          variant="ghost"
          size="sm"
          loading={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {t('Refresh mail statistics')}
        </Button>
      </div>
      <div className="usage-services" role="group" aria-label={t('Mail processing category')}>
        {groups.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === groupId}
            onClick={() => {
              setGroupId(item.id);
              setMetricId('');
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <p className="usage-empty" role="status">
          {t('Loading mail statistics…')}
        </p>
      ) : null}
      {query.isError ? (
        denied ? (
          <p role="status" className="usage-empty">
            {t('You do not have permission to view resource usage.')}
          </p>
        ) : (
          <ErrorPanel
            message={t('Mail statistics unavailable.')}
            onRetry={() => void query.refetch()}
          />
        )
      ) : null}
      {!denied && group ? (
        group.status === 'limit_exceeded' ? (
          <p className="usage-empty" role="status">
            {t('This range exceeds the 5,000-record statistics limit. Try a shorter range.')}
          </p>
        ) : metric ? (
          <>
            <div className="usage-workspace">
              <div className="usage-metrics" role="group" aria-label={t('Mail processing metric')}>
                {group.metrics.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    aria-pressed={item.id === metric.id}
                    onClick={() => setMetricId(item.id)}
                  >
                    <span>{t(item.label)}</span>
                    <strong>{formatValue(summarize(item), item.unit, locale)}</strong>
                    <small>
                      {t(
                        item.aggregation === 'average'
                          ? 'Weighted sample average'
                          : item.aggregation === 'max'
                            ? 'Period maximum'
                            : 'Recorded period total',
                      )}
                    </small>
                  </button>
                ))}
              </div>
              <UsageChart key={`${groupId}-${metric.id}-${days}`} metric={metric} />
            </div>
            <details className="usage-data">
              <summary>{t('View mail daily values')}</summary>
              <table>
                <caption>{t(metric.label)} · UTC</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('Date')}</th>
                    <th scope="col">{t('Usage')}</th>
                    {metric.aggregation === 'average' ? <th scope="col">{t('Samples')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {metric.points.map((p) => (
                    <tr key={p.date}>
                      <th scope="row">{p.date}</th>
                      <td>{formatValue(p.value, metric.unit, locale)}</td>
                      {metric.aggregation === 'average' ? <td>{p.sampleCount ?? 0}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        ) : null
      ) : null}
      {groupId === 'receipts' ? (
        <p className="usage-footnote">
          {t(
            'Completed receipts expire after about 24 hours. Raw sizes and inbound latency describe retained samples, not complete historical traffic.',
          )}
        </p>
      ) : null}
      <p className="usage-footnote">
        {t(
          'Current retained metadata, grouped by creation date. Deletion or cleanup changes historical values. Latency includes queueing, scheduled waiting and recovery; it is not CPU time or memory usage.',
        )}
      </p>
      {query.data && !denied ? (
        <p className="usage-updated">
          {t('Checked at')}{' '}
          {new Date(query.data.generatedAt).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
        </p>
      ) : null}
    </Card>
  );
}
