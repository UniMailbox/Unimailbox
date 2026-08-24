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
import { webhookEventsQuery, type WebhookEventDelivery } from './admin-queries';

export function WebhookEventsPage(): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  return <WebhookEventsContent />;
}

function WebhookEventsContent(): ReactElement {
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
        <p>Loading…</p>
      </main>
    );
  }

  if (!hasData && apiError !== null && apiError.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read webhook events."
        >
          <p data-testid="admin-not-authorized-message">
            Ask an administrator if you need access to this area.
          </p>
        </Card>
      </main>
    );
  }

  if (!hasData && apiError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <header className="admin-header">
          <h1>Webhook events</h1>
        </header>
        <Card title="Could not load webhook events" description="Webhook deliveries are unavailable.">
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={() => {
              void query.refetch();
            }}
            retryLabel="Retry"
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const items: WebhookEventDelivery[] = query.data ?? [];

  return (
    <main className="admin-page" data-testid="admin-webhook-events-page">
      <header className="admin-header">
        <h1>Webhook events</h1>
      </header>
      <Card
        title="Webhook deliveries"
        description="Recent provider webhook deliveries, newest first."
      >
        {apiError !== null ? (
          <div
            className="admin-error-banner"
            role="alert"
            data-testid="webhook-events-error-banner"
          >
            <p>Could not load webhook events: {apiError.message}</p>
            <Button
              type="button"
              variant="secondary"
              data-testid="webhook-events-banner-retry"
              onClick={() => {
                void query.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {items.length === 0 ? (
          <p data-testid="admin-webhook-events-empty">
            No webhook deliveries have been recorded yet.
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
  return (
    <li
      className="admin-webhook-event-row"
      data-testid="admin-webhook-event-row"
      data-event-id={item.id}
    >
      <div className="admin-webhook-event-row-meta">
        <span className="admin-webhook-event-row-type">{item.event_type}</span>
        <span className={`admin-webhook-event-status admin-webhook-event-status-${item.status}`}>
          {item.status}
        </span>
        <span className="admin-webhook-event-row-date">{item.created_at}</span>
      </div>
      <div className="admin-webhook-event-row-detail">
        <span>connection: {item.connection_id}</span>
        <span>message: {item.message_id ?? '—'}</span>
      </div>
    </li>
  );
}
