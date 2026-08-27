// apps/web — AuditEventsPage.
//
// CAP-044 Slice 2 (AC 13; CAP-033 absorbed, D-CAP-044-E). The audit-trail
// viewer at /admin/audit-events: session-gated (the router's beforeLoad
// owns the redirect; this component owns the post-guard null fallback,
// same contract as InboxListPage), with actor / resource-pair / action
// filters and cursor "Load more" accumulation.
//
// State surface (data-first since the Slice 2 fix pass (e), same class
// as the Slice 1 ReplyComposer fix — a query error must never wipe
// loaded data):
//   - Loading (session or first page) — the admin-loading placeholder.
//   - Session null — <Unauthorized variant="expired" /> (D-CAP-041-9).
//   - 403 PERMISSION_DENIED with NO data — the not-authorized panel
//     (AC 14, role="status"): the session descriptor carries no
//     role/permission signal, so a member reaches this page and the
//     SERVER enforces audit.read. Queries do not retry, so the denied
//     member sees the panel after exactly one request — no crash loop.
//   - Any other error with data — the rows and the filter form STAY
//     mounted; the error renders as a banner (role="alert") above the
//     list. A failed background refetch or a failed load-more keeps the
//     already-loaded pages on screen.
//   - Any other error with NO data — the error panel renders WITH the
//     filter form still mounted: an invalid actorUserId can be
//     corrected and Applied (a new filter value is a new query key and
//     a fresh first page) instead of a dead-end Retry loop.
//   - INVALID_CURSOR — the recovery is "Start over" via
//     `queryClient.resetQueries`, NOT Retry: TanStack v5 `refetch()` on
//     an infinite query replays ALL stored pageParams, so after a
//     CURSOR_SIGNING_KEY rotation a stored ≥2-page chain fails forever
//     under Retry (R-API-005; D-CAP-044-L records the same hazard on
//     the messages surfaces).
//   - Empty — explicit no-match message.
//
// >150 lines because the page owns five render states + a filter form +
// a row renderer; splitting the row out would trade one readable page for
// a file whose only consumer is this list.
import { useState, type FormEvent, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { auditActionSchema, type AuditAction, type AuditEventItem } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import {
  auditEventsInfiniteQuery,
  adminQueryKeys,
  type AuditEventFilterInput,
} from './admin-queries';

export function AuditEventsPage(): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  // D-CAP-041-9 fallback: a null descriptor after the router guard is the
  // expired-session surface; the Sign-in CTA inside it is the recovery.
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  return <AuditEventsContent />;
}

function AuditEventsContent(): ReactElement {
  // Draft form state — only an explicit Apply commits filters to the
  // query key, so typing never refires the query per keystroke.
  const [actorUserId, setActorUserId] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState<AuditEventFilterInput>({});
  const [pairError, setPairError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  // Fix (a): the reset target must match the hook's userId-scoped key.
  const sessionQuery = authSessionQuery();
  const query = auditEventsInfiniteQuery(applied);

  const applyFilters = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // The resource pair rule, enforced client-side: the server's schema
    // rejects a half-pair with 400; catching it here keeps the request
    // count honest and gives an inline message instead of an error panel.
    const hasType = resourceType.trim() !== '';
    const hasId = resourceId.trim() !== '';
    if (hasType !== hasId) {
      setPairError('Resource type and resource id must be supplied together.');
      return;
    }
    setPairError(null);
    setApplied({
      ...(actorUserId.trim() !== '' ? { actorUserId: actorUserId.trim() } : {}),
      ...(hasType ? { resourceType: resourceType.trim() } : {}),
      ...(hasId ? { resourceId: resourceId.trim() } : {}),
      ...(action !== '' ? { action: action as AuditAction } : {}),
    });
  };

  // Fix (e), data-first ordering: in TanStack v5 `query.data` survives a
  // failed background refetch and a failed load-more, so the accumulated
  // rows keep rendering and the error becomes a banner — never a wipe.
  const hasData = query.data !== undefined;
  const apiError =
    query.error === null
      ? null
      : query.error instanceof ApiError
        ? query.error
        : new ApiError('UNKNOWN', query.error.message, 0);

  // INVALID_CURSOR recovery (R-API-005). `refetch()` is the WRONG tool
  // here: an infinite query's refetch replays every stored pageParam, so
  // a cursor chain broken mid-walk (e.g. a CURSOR_SIGNING_KEY rotation)
  // fails again on every page. `resetQueries` drops the accumulated
  // chain and refetches page 1 of the CURRENT filter set.
  const startOver = (): void => {
    void queryClient.resetQueries({
      queryKey: adminQueryKeys.auditEvents(sessionQuery.data?.userId ?? 'anonymous', applied),
    });
  };

  // Fix (b): isPending, NOT isLoading — an offline-paused first fetch
  // has isFetching=false (so isLoading=false) and would fall through to
  // the no-data error/empty branches; isPending stays true until data
  // or an error exists. See UsersPage for the full note.
  if (!hasData && query.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }

  const filterForm = (
    <Card title="Filters" description="Actor, resource, or action — combinable.">
      <form onSubmit={applyFilters} data-testid="audit-filters">
        <Input
          id="audit-filter-actor"
          label="Actor user id"
          placeholder="uuid"
          value={actorUserId}
          onChange={(e) => setActorUserId(e.target.value)}
        />
        <Input
          id="audit-filter-resource-type"
          label="Resource type"
          placeholder="message"
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
        />
        <Input
          id="audit-filter-resource-id"
          label="Resource id"
          placeholder="resource id"
          value={resourceId}
          onChange={(e) => setResourceId(e.target.value)}
        />
        <div className="wizard-field">
          <label className="input-label" htmlFor="audit-filter-action">
            Action
          </label>
          <select
            id="audit-filter-action"
            className="input"
            data-testid="audit-action-select"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">(any action)</option>
            {auditActionSchema.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        {pairError !== null ? (
          <p className="input-error" role="alert" data-testid="audit-filter-error">
            {pairError}
          </p>
        ) : null}
        <div className="wizard-actions">
          <Button type="submit" variant="primary" data-testid="audit-apply-filters">
            Apply
          </Button>
        </div>
      </form>
    </Card>
  );

  if (!hasData && apiError !== null && apiError.code === 'PERMISSION_DENIED') {
    // AC 14: the member surface. The server is the authorization truth
    // (D-CAP-044-D); the client has no role signal to pre-hide with.
    // role="status" (fix (e)): the denial is expected member behavior,
    // not an alert the user must act on.
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read the audit trail."
        >
          <p data-testid="admin-not-authorized-message">
            Ask an administrator if you need access to this area.
          </p>
        </Card>
      </main>
    );
  }

  if (!hasData && apiError !== null) {
    // Fix (e): the error panel keeps the FILTER FORM mounted so an
    // invalid filter value (e.g. a malformed actorUserId) can be
    // corrected and Applied — a new filter value is a new query key and
    // a fresh first page. Retry alone would replay the same failing
    // request forever.
    return (
      <main className="admin-page" data-testid="admin-error">
        <header className="admin-header">
          <h1>Audit events</h1>
        </header>
        {filterForm}
        <Card title="Could not load audit events" description="The audit trail is unavailable.">
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={
              apiError.code === 'INVALID_CURSOR'
                ? startOver
                : () => {
                    void query.refetch();
                  }
            }
            retryLabel={apiError.code === 'INVALID_CURSOR' ? 'Start over' : 'Retry'}
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const items: AuditEventItem[] = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="admin-page" data-testid="audit-events-page">
      <header className="admin-header">
        <h1>Audit events</h1>
      </header>
      {filterForm}
      <Card title="Audit trail" description="Newest first.">
        {apiError !== null ? (
          // Fix (e): errors with data on screen render as a banner ABOVE
          // the list; the loaded rows below are never wiped by a failed
          // background refetch or a failed load-more.
          <div className="admin-error-banner" role="alert" data-testid="audit-error-banner">
            <p>Could not load audit events: {apiError.message}</p>
            {apiError.code === 'INVALID_CURSOR' ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="audit-start-over"
                onClick={startOver}
              >
                Start over
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                data-testid="audit-banner-retry"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Retry
              </Button>
            )}
          </div>
        ) : null}
        {items.length === 0 ? (
          <p data-testid="audit-events-empty">No audit events match these filters.</p>
        ) : (
          <>
            <ul className="audit-event-list" data-testid="audit-events-list">
              {items.map((item) => (
                <AuditEventRow key={item.id} item={item} />
              ))}
            </ul>
            {query.hasNextPage ? (
              <div className="admin-pagination">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="audit-load-more"
                  onClick={() => {
                    void query.fetchNextPage();
                  }}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </main>
  );
}

function AuditEventRow({ item }: { readonly item: AuditEventItem }): ReactElement {
  return (
    <li className="audit-event-row" data-testid="audit-event-row" data-event-id={item.id}>
      <div className="audit-event-row-meta">
        <span className="audit-event-row-action">{item.action}</span>
        <span className="audit-event-row-date">{item.createdAt}</span>
      </div>
      <div className="audit-event-row-detail">
        <span>actor: {item.actorUserId ?? 'system'}</span>
        <span>
          resource: {item.resourceType}
          {item.resourceId !== null ? `:${item.resourceId}` : ''}
        </span>
        <span>request: {item.requestId ?? '—'}</span>
      </div>
    </li>
  );
}
