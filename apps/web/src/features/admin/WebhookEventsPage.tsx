import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { PageHeader } from '../../components/ui/PageHeader';
// apps/web — WebhookEventsPage.
//
// CAP-044 Slice 3 (AC 21). The webhook-delivery view at
// /admin/webhook-events over the LIVE CAP-025 endpoint: one plain list
// (newest first, server-truncated — no cursor on this surface), rows
// carrying delivery metadata only (connection, event type, message,
// status, timestamp). The raw provider payload is intentionally absent
// — the list view does not need body content.
//
// State surface: the AuditEventsPage contract (data-first since the
// Slice 2 fix pass (e)) — loading, session-null, not-authorized
// (role="status"), error panel without data, banner with data, empty.
// No INVALID_CURSOR branch: this endpoint is not cursor-paginated.
import { type ReactElement } from 'react';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Button } from '../../components/ui/Button';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import { webhookEventsQuery, type WebhookEventDelivery } from './admin-queries';

export function WebhookEventsPage(): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  return <WebhookEventsContent />;
}

function WebhookEventsContent(): ReactElement {
  const t = useT();
  const query = webhookEventsQuery();

  const hasData = query.data !== undefined;
  const apiError =
    query.error === null
      ? null
      : query.error instanceof ApiError
        ? query.error
        : new ApiError('UNKNOWN', query.error.message, 0);

  // Fix (b): isPending, NOT isLoading — an offline-paused first fetch
  // has isLoading===false and would fall through to the empty state;
  // isPending holds until data or error exists. See UsersPage.
  if (!hasData && query.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }

  if (!hasData && apiError !== null && apiError.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title={t('Administrator access required')}
          description={t('Your account does not have permission to read webhook events.')}
        >
          <p data-testid="admin-not-authorized-message">
            {t('Ask an administrator if you need access to this area.')}
          </p>
        </Card>
      </main>
    );
  }

  if (!hasData && apiError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <PageHeader title={t('Webhook events')} />
        <Card
          title={t('Could not load webhook events')}
          description={t('Webhook deliveries are unavailable.')}
        >
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={() => {
              void query.refetch();
            }}
            retryLabel={t('Retry')}
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const items: WebhookEventDelivery[] = query.data ?? [];

  return (
    <main className="admin-page" data-testid="admin-webhook-events-page">
      <PageHeader title={t('Webhook events')} />
      <Card title={t('Webhook deliveries')}>
        {apiError !== null ? (
          <div
            className="admin-error-banner"
            role="alert"
            data-testid="webhook-events-error-banner"
          >
            <p>
              {t('Could not load webhook events: ')}
              {apiError.message}
            </p>
            <Button
              type="button"
              variant="secondary"
              data-testid="webhook-events-banner-retry"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('Retry')}
            </Button>
          </div>
        ) : null}
        {items.length === 0 ? (
          <p data-testid="admin-webhook-events-empty">
            {t('No webhook deliveries have been recorded yet.')}
          </p>
        ) : (
          <ul className="admin-webhook-event-list" data-testid="admin-webhook-events-list">
            {items.map((item) => (
              <WebhookEventRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

function WebhookEventRow({ item }: { readonly item: WebhookEventDelivery }): ReactElement {
  const t = useT();
  return (
    <li
      className="admin-webhook-event-row"
      data-testid="admin-webhook-event-row"
      data-event-id={item.id}
    >
      <div className="admin-webhook-event-row-meta">
        <span className="admin-webhook-event-row-type">{item.event_type}</span>
        <span className={`admin-webhook-event-status admin-webhook-event-status-${item.status}`}>
          {t(item.status)}
        </span>
        <LocalDateTime className="admin-webhook-event-row-date" value={item.created_at} />
      </div>
      <div className="admin-webhook-event-row-detail">
        <span>
          {t('connection: ')}
          {item.connection_id}
        </span>
        <span>
          {t('message: ')}
          {item.message_id ?? '—'}
        </span>
      </div>
    </li>
  );
}
