import { useEffect, useId, useRef, useState } from 'react';
import type { ResourceMetric } from '@unimailbox/contracts';
import { useLanguage, useT } from '../../infrastructure/i18n/locale';
export function summarize(metric: ResourceMetric): number | null {
  if (metric.aggregation === 'average') {
    const points = metric.points.filter(
      (point) => point.value !== null && (point.sampleCount ?? 0) > 0,
    );
    const count = points.reduce((sum, point) => sum + (point.sampleCount ?? 0), 0);
    return count
      ? points.reduce((sum, point) => sum + (point.value ?? 0) * (point.sampleCount ?? 0), 0) /
          count
      : null;
  }
  const values = metric.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  if (!values.length) return null;
  return metric.aggregation === 'max' ? Math.max(...values) : values.reduce((a, b) => a + b, 0);
}
export function formatValue(
  value: number | null,
  unit: ResourceMetric['unit'],
  locale: string,
): string {
  if (value === null) return '—';
  const format = (v: number) =>
    v.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 2 });
  if (unit === 'bytes') {
    const power = Math.max(
      0,
      Math.min(4, value > 0 ? Math.floor(Math.log(value) / Math.log(1024)) : 0),
    );
    return `${format(value / 1024 ** power)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`;
  }
  if (unit === 'milliseconds') {
    if (value < 1000) return `${format(value)} ms`;
    if (value < 60000) return `${format(value / 1000)} s`;
    if (value < 3600000) return `${format(value / 60000)} min`;
    return `${format(value / 3600000)} h`;
  }
  return format(value);
}

export function UsageChart({ metric }: { metric: ResourceMetric }) {
  const t = useT();
  const locale = useLanguage();
  const id = useId();
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    if (!figure.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, entry.contentRect.width));
    });
    observer.observe(figure.current);
    return () => observer.disconnect();
  }, []);
  const [active, setActive] = useState<number | null>(null);
  const values = metric.points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const ceiling = Math.max(1, ...values);
  const height = 220,
    left = 68,
    top = 14,
    plotHeight = 168,
    plotWidth = width - left - 16;
  const step = plotWidth / metric.points.length;
  const point = active === null ? null : metric.points[active];
  return (
    <figure ref={figure} className="usage-chart">
      <figcaption>
        <strong>{t(metric.label)}</strong>
        <span aria-live="polite">
          {point
            ? `${point.date} · ${formatValue(point.value, metric.unit, locale)}`
            : t('Daily usage · UTC')}
        </span>
      </figcaption>
      {!values.length ? (
        <div className="usage-no-data">
          {t('No samples in this date range. Try another range or resource.')}
        </div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id}>
          <title id={id}>
            {t(metric.label)} · {t('Daily usage · UTC')}
          </title>
          {[0, 0.5, 1].map((fraction) => (
            <g key={fraction} className="usage-axis">
              <line
                x1={left}
                x2={width - 16}
                y1={top + plotHeight * (1 - fraction)}
                y2={top + plotHeight * (1 - fraction)}
              />
              <text x={left - 10} y={top + plotHeight * (1 - fraction) + 4} textAnchor="end">
                {metric.unit === 'count'
                  ? new Intl.NumberFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
                      notation: 'compact',
                      maximumFractionDigits: 1,
                    }).format(ceiling * fraction)
                  : formatValue(ceiling * fraction, metric.unit, locale)}
              </text>
            </g>
          ))}
          {metric.points.map((p, index) => {
            const x = left + index * step + step * 0.16;
            const barHeight = p.value === null ? 0 : Math.max(2, (p.value / ceiling) * plotHeight);
            return (
              <g key={p.date}>
                <rect
                  className={`usage-bar${active === index ? ' is-active' : ''}${p.value === null ? ' is-missing' : ''}`}
                  x={x}
                  y={top + plotHeight - barHeight}
                  width={step * 0.68}
                  height={Math.max(2, barHeight)}
                  rx={2}
                  tabIndex={0}
                  role="img"
                  aria-label={`${p.date}: ${p.value === null ? t('No data') : formatValue(p.value, metric.unit, locale)}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(index)}
                  onBlur={() => setActive(null)}
                >
                  <title>
                    {p.date}:{' '}
                    {p.value === null ? t('No data') : formatValue(p.value, metric.unit, locale)}
                  </title>
                </rect>
                {metric.points.length === 7 ||
                (index % 7 === 0 && index < metric.points.length - 3) ||
                index === metric.points.length - 1 ? (
                  <text
                    className="usage-date"
                    x={left + (index + 0.5) * step}
                    y={height - 8}
                    textAnchor="middle"
                  >
                    {p.date.slice(5).replace('-', '/')}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}
