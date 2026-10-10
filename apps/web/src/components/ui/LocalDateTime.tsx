import { getLanguage, useLanguage } from '../../infrastructure/i18n/locale';
import type { ReactElement, TimeHTMLAttributes } from 'react';

/**
 * Parses the timestamp formats emitted by the API as an instant in UTC.
 *
 * D1 text timestamps historically omit a zone (`YYYY-MM-DD HH:mm:ss`), while
 * newer API responses use RFC 3339. A bare value must not be handed directly
 * to `new Date()` because browsers interpret it in the user's local zone.
 */
function parseUtcTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  let normalized = trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    normalized = `${normalized}T00:00:00Z`;
  } else if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) {
    normalized = `${normalized.replace(' ', 'T')}Z`;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

/** Converts an API timestamp into a valid ISO value for the `<time>` element. */
export function toUtcIsoTimestamp(value: string): string {
  return parseUtcTimestamp(value)?.toISOString() ?? value;
}

/** Formats an API timestamp using the browser's current locale and time zone. */
export function formatLocalDateTime(value: string): string {
  const parsed = parseUtcTimestamp(value);
  if (parsed === null) return value;

  return new Intl.DateTimeFormat(getLanguage(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

export interface LocalDateTimeProps
  extends Omit<TimeHTMLAttributes<HTMLTimeElement>, 'dateTime' | 'children'> {
  readonly value: string;
}

/**
 * Presentational timestamp for user-facing surfaces.
 *
 * The original UTC value remains available to assistive technology and
 * inspection without becoming the visible value or changing query semantics.
 */
export function LocalDateTime({ value, title, ...props }: LocalDateTimeProps): ReactElement {
  useLanguage();
  return (
    <time {...props} dateTime={toUtcIsoTimestamp(value)} title={title ?? `UTC ${value}`}>
      {formatLocalDateTime(value)}
    </time>
  );
}
