// apps/web — UsersPage.
//
// CAP-044 Slice 3 (AC 19). The admin users list at /admin/users: session-
// gated (the router's beforeLoad owns the redirect; this component owns
// the post-guard null fallback, same contract as AuditEventsPage), with
// cursor "Load more" accumulation. No filters — the users list is a
// keyset walk (AC 15).
//
// State surface (data-first, the AuditEventsPage contract since the
// Slice 2 fix pass (e) — a query error must never wipe loaded data):
//   - Loading (session or first page) — the admin-loading placeholder.
//   - Session null — <Unauthorized variant="expired" /> (D-CAP-041-9).
//   - 403 PERMISSION_DENIED with NO data — the not-authorized panel
//     (role="status"): the session descriptor carries no role/permission
//     signal, so a member reaches this page and the SERVER enforces
//     user.read. Queries do not retry, so the denied member sees the
//     panel after exactly one request.
//   - Any other error with data — the rows STAY mounted; the error
//     renders as a banner (role="alert") above the list.
//   - Any other error with NO data — the error panel.
//   - INVALID_CURSOR — "Start over" via `queryClient.resetQueries`
//     (refetch() would replay ALL stored pageParams; see AuditEventsPage).
//   - Empty — explicit message (a deployment with only the caller).
import { type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserListItem } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Button } from '../../components/ui/Button';
import { adminQueryKeys, usersInfiniteQuery } from './admin-queries';

export function UsersPage(): ReactElement {
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

  return <UsersContent />;
}

function UsersContent(): ReactElement {
  const queryClient = useQueryClient();
  // Fix (a): the reset target must match the hook's userId-scoped key.
  const sessionQuery = authSessionQuery();
  const query = usersInfiniteQuery();

  // Data-first ordering (fix pass (e)): `query.data` survives a failed
  // background refetch and a failed load-more, so accumulated rows keep
  // rendering and the error becomes a banner — never a wipe.
  const hasData = query.data !== undefined;
  const apiError =
    query.error === null
      ? null
      : query.error instanceof ApiError
        ? query.error
        : new ApiError('UNKNOWN', query.error.message, 0);

  // INVALID_CURSOR recovery (R-API-005). `resetQueries` drops the
  // accumulated chain and refetches page 1; `refetch()` would replay
  // every stored pageParam (the AuditEventsPage note applies verbatim).
  const startOver = (): void => {
    void queryClient.resetQueries({
      queryKey: adminQueryKeys.users(sessionQuery.data?.userId ?? 'anonymous'),
    });
  };

  // Fix (b): isPending, NOT isLoading. A first fetch paused by the
  // network (offline) has isFetching=false, so isLoading is ALSO false —
  // an isLoading gate would fall through to the empty list and render a
  // false "No users exist yet" while nothing has loaded. isPending is
  // true until data or an error exists, which is exactly the gate
  // wanted.
  if (!hasData && query.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }

  if (!hasData && apiError !== null && apiError.code === 'PERMISSION_DENIED') {
    // The member surface. The server is the authorization truth; the
    // client has no role signal to pre-hide with. role="status": the
    // denial is expected member behavior, not an alert to act on.
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read the users list."
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
          <h1>Users</h1>
        </header>
        <Card title="Could not load users" description="The users list is unavailable.">
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

  const items: UserListItem[] = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="admin-page" data-testid="admin-users-page">
      <header className="admin-header">
        <h1>Users</h1>
      </header>
      <Card title="Users" description="Newest first. Status shown as stored.">
        {apiError !== null ? (
          // Errors with data on screen render as a banner ABOVE the list;
          // the loaded rows below are never wiped.
          <div className="admin-error-banner" role="alert" data-testid="users-error-banner">
            <p>Could not load users: {apiError.message}</p>
            {apiError.code === 'INVALID_CURSOR' ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="users-start-over"
                onClick={startOver}
              >
                Start over
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                data-testid="users-banner-retry"
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
          <p data-testid="admin-users-empty">No users exist yet.</p>
        ) : (
          <>
            <ul className="admin-user-list" data-testid="admin-users-list">
              {items.map((item) => (
                <UserRow key={item.id} item={item} />
              ))}
            </ul>
            {query.hasNextPage ? (
              <div className="admin-pagination">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="admin-users-load-more"
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

function UserRow({ item }: { readonly item: UserListItem }): ReactElement {
  return (
    <li className="admin-user-row" data-testid="admin-user-row" data-user-id={item.id}>
      <div className="admin-user-row-meta">
        <span className="admin-user-row-email">{item.email}</span>
        <span className={`admin-user-status admin-user-status-${item.status}`}>{item.status}</span>
      </div>
      <div className="admin-user-row-detail">
        <span>name: {item.displayName ?? '—'}</span>
        <span>created: {item.createdAt}</span>
      </div>
    </li>
  );
}
