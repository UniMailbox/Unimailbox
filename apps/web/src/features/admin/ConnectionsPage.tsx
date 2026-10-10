import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { PageHeader } from '../../components/ui/PageHeader';
// apps/web — ConnectionsPage.
//
// CAP-044 Slice 3 (AC 20). The provider-connections view at
// /admin/connections over the LIVE CAP-025/CAP-040 endpoints: rows show
// provider, status, webhookConfigured, webhookUrl; the secret is NOT in
// the list response (R-SECRET-003) and is reachable only through the
// audited reveal endpoint, which this page calls behind a confirm
// dialog.
//
// R-SECRET-003 handling of the revealed value:
//   - displayed ONCE, in transient React state (`revealResult`), with
//     the "shown once / reveal is audited" note visible next to it;
//   - never logged, never written to localStorage or any other store.
//     The one other place it exists is the reveal mutation's TanStack
//     MutationCache entry, collected the moment the mutation settles or
//     the row unmounts (`gcTime: 0`, fix (f)) — never a query cache,
//     which would retain it for the cache lifetime (pinned by the
//     ConnectionsPage test's console + storage spies);
//   - cleared by the Hide button or by leaving the page (state is
//     component-local and dies with the route).
//
// State surface: the AuditEventsPage contract (data-first since the
// Slice 2 fix pass (e)) — loading, session-null, not-authorized
// (role="status"), error panel without data, banner with data, empty.
// The reveal flow layers a per-row confirm dialog (AlertDialog) on top;
// a reveal failure (e.g. 403 for an operator without provider.sync)
// renders INSIDE the dialog's error slot, rows stay mounted.
import { useState, type ReactElement } from 'react';
import { useMutation } from '@tanstack/react-query';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Button } from '../../components/ui/Button';
import { AlertDialog } from '../../components/ui/AlertDialog';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import {
  adminConnectionsQuery,
  revealWebhookSecret,
  type AdminConnection,
  type WebhookSecretReveal,
} from './admin-queries';

export function ConnectionsPage(): ReactElement {
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

  return <ConnectionsContent />;
}

function ConnectionsContent(): ReactElement {
  const t = useT();
  const query = adminConnectionsQuery();

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
          description={t('Your account does not have permission to read provider connections.')}
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
        <PageHeader title={t('Connections')} />
        <Card
          title={t('Could not load connections')}
          description={t('Provider connections are unavailable.')}
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

  const items: AdminConnection[] = query.data ?? [];

  return (
    <main className="admin-page" data-testid="admin-connections-page">
      <PageHeader title={t('Connections')} />
      <Card title={t('Provider connections')}>
        {apiError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="connections-error-banner">
            <p>
              {t('Could not load connections: ')}
              {apiError.message}
            </p>
            <Button
              type="button"
              variant="secondary"
              data-testid="connections-banner-retry"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('Retry')}
            </Button>
          </div>
        ) : null}
        {items.length === 0 ? (
          <p data-testid="admin-connections-empty">
            {t('No provider connections are configured yet.')}
          </p>
        ) : (
          <ul className="admin-connection-list" data-testid="admin-connections-list">
            {items.map((item) => (
              <ConnectionRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

function ConnectionRow({ item }: { readonly item: AdminConnection }): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  // Transient, component-local reveal state (R-SECRET-003 — one-time
  // display; never cached, stored, or logged).
  const [confirming, setConfirming] = useState(false);
  const [revealed, setRevealed] = useState<WebhookSecretReveal | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const revealMutation = useMutation({
    mutationFn: (connectionId: string) => revealWebhookSecret(apiClient, connectionId),
    // Fix (f): gcTime 0 — the resolved secret exists in the
    // MutationCache only until this mutation settles/unmounts; it must
    // not be retained (and inspectable in devtools) past the dialog.
    gcTime: 0,
    // Fix (f): a retry must not show the PREVIOUS attempt's error next
    // to the pending confirm — clear it when the attempt starts.
    // onMutate runs before mutationFn, so the slot is clean even while
    // the request is in flight.
    onMutate: () => {
      setRevealError(null);
    },
    onSuccess: (result) => {
      // Display once. The value lives in this state and nowhere else; it
      // is cleared by Hide, a new reveal, or unmount.
      setRevealed(result);
      setRevealError(null);
      setConfirming(false);
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError ? error.message : 'Reveal failed.';
      setRevealError(message);
    },
  });

  return (
    <li
      className="admin-connection-row"
      data-testid="admin-connection-row"
      data-connection-id={item.id}
    >
      <div className="admin-connection-row-meta">
        <span className="admin-connection-row-provider">{item.providerKey}</span>
        <span className={`admin-connection-status admin-connection-status-${item.status}`}>
          {t(item.status)}
        </span>
      </div>
      <div className="admin-connection-row-detail">
        <span>
          {t('label: ')}
          {item.label}
        </span>
        <span>
          {t('webhook:')}{' '}
          {item.webhookConfigured
            ? t('configured ({url})', { url: item.webhookUrl ?? t('no url') })
            : t('not configured')}
        </span>
        <span>
          {t('created: ')}
          <LocalDateTime value={item.createdAt} />
        </span>
      </div>
      <div className="admin-connection-row-actions">
        {item.webhookConfigured ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid={`admin-connection-reveal-${item.id}`}
            onClick={() => {
              // A new reveal clears the previous one-time value first.
              setRevealed(null);
              setRevealError(null);
              setConfirming(true);
            }}
          >
            {t('Reveal webhook secret')}
          </Button>
        ) : null}
      </div>
      {revealed !== null && revealed.id === item.id ? (
        // The one-time display. The note is part of the R-SECRET-003
        // contract: the operator must know the value is shown once and
        // that the reveal was recorded in the audit trail.
        <div className="admin-secret-reveal" data-testid={`admin-secret-revealed-${item.id}`}>
          <p className="admin-secret-reveal-note">
            {t('Shown once — copy it now. Every reveal is recorded in the audit trail.')}
          </p>
          <code className="admin-secret-reveal-value">{revealed.webhookSecret}</code>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-testid={`admin-secret-hide-${item.id}`}
            onClick={() => {
              setRevealed(null);
            }}
          >
            {t('Hide')}
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={confirming}
        name={t('Reveal webhook secret for {value0}', { value0: item.providerKey })}
        title={t('Reveal the webhook signing secret?')}
        confirmLabel={t('Reveal')}
        confirmDisabled={revealMutation.isPending}
        confirmBusy={revealMutation.isPending}
        error={revealError}
        onConfirm={() => {
          revealMutation.mutate(item.id);
        }}
        onCancel={() => {
          setConfirming(false);
          setRevealError(null);
        }}
      >
        {t('The secret for ')}
        <strong>{item.label}</strong> ({item.providerKey}
        {t(') will be shown once. This action is audited. ')}
      </AlertDialog>
    </li>
  );
}
