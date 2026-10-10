import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { PageHeader } from '../../components/ui/PageHeader';
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
import { useState, type FormEvent, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UserListItem } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/Table';
import {
  adminQueryKeys,
  useCreateAdminUserMutation,
  useResetAdminUserPasswordMutation,
  useUpdateAdminUserStatusMutation,
  usersInfiniteQuery,
} from './admin-queries';

export function UsersPage(): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
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
  const t = useT();
  const queryClient = useQueryClient();
  // Fix (a): the reset target must match the hook's userId-scoped key.
  const sessionQuery = authSessionQuery();
  const query = usersInfiniteQuery();
  const createMutation = useCreateAdminUserMutation();
  const resetMutation = useResetAdminUserPasswordMutation();
  const statusMutation = useUpdateAdminUserStatusMutation();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [oneTimePassword, setOneTimePassword] = useState<{
    readonly userId: string;
    readonly password: string;
    readonly expiresAt: string;
  } | null>(null);
  const [mutationError, setMutationError] = useState<ApiError | null>(null);

  const submitCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setMutationError(null);
    try {
      const created = await createMutation.mutateAsync({
        email,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      });
      setOneTimePassword({
        userId: created.id,
        password: created.initialPassword,
        expiresAt: created.initialPasswordExpiresAt,
      });
      setEmail('');
      setDisplayName('');
    } catch (cause) {
      setMutationError(
        cause instanceof ApiError ? cause : new ApiError('UNKNOWN', 'Could not create user', 500),
      );
    }
  };

  const resetPassword = async (userId: string): Promise<void> => {
    setMutationError(null);
    try {
      const reset = await resetMutation.mutateAsync(userId);
      setOneTimePassword({
        userId,
        password: reset.initialPassword,
        expiresAt: reset.initialPasswordExpiresAt,
      });
    } catch (cause) {
      setMutationError(
        cause instanceof ApiError
          ? cause
          : new ApiError('UNKNOWN', 'Could not reset password', 500),
      );
    }
  };

  const changeStatus = async (userId: string, status: 'active' | 'banned'): Promise<void> => {
    setMutationError(null);
    try {
      await statusMutation.mutateAsync({ userId, status });
    } catch (cause) {
      setMutationError(
        cause instanceof ApiError
          ? cause
          : new ApiError('UNKNOWN', 'Could not update user status', 500),
      );
    }
  };

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
        <ContentSkeleton variant="list" />
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
          title={t('Administrator access required')}
          description={t('Your account does not have permission to read the users list.')}
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
        <PageHeader title={t('Users')} />
        <Card title={t('Could not load users')} description={t('The users list is unavailable.')}>
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
            retryLabel={apiError.code === 'INVALID_CURSOR' ? t('Start over') : t('Retry')}
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const items: UserListItem[] = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="admin-page" data-testid="admin-users-page">
      <PageHeader title={t('Users')} />
      <Card
        title={t('Create account')}
        description={t('The generated initial password is shown once and expires after 24 hours.')}
      >
        <form
          onSubmit={(event) => void submitCreate(event)}
          data-testid="admin-create-user-form"
          noValidate
        >
          <Input
            id="admin-user-email"
            type="email"
            label={t('Email')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <Input
            id="admin-user-display-name"
            label={t('Display name')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Button
            type="submit"
            loading={createMutation.isPending}
            disabled={createMutation.isPending || email.trim() === ''}
          >
            {createMutation.isPending ? t('Creating…') : t('Create account')}
          </Button>
        </form>
      </Card>
      {mutationError !== null ? (
        <div className="admin-error-banner" role="alert" data-testid="admin-user-mutation-error">
          <p>{mutationError.message}</p>
          <span data-testid="error-code">{mutationError.code}</span>
        </div>
      ) : null}
      {oneTimePassword !== null ? (
        <Card
          title={t('Initial password')}
          description={t('Copy this password now. It will not be shown again.')}
        >
          <p data-testid="admin-one-time-password">
            <code>{oneTimePassword.password}</code>
          </p>
          <p>
            {t('Expires: ')}
            <LocalDateTime value={oneTimePassword.expiresAt} />
          </p>
          <Button type="button" variant="secondary" onClick={() => setOneTimePassword(null)}>
            {t('Close')}
          </Button>
        </Card>
      ) : null}
      <Card title={t('Users')}>
        {apiError !== null ? (
          // Errors with data on screen render as a banner ABOVE the list;
          // the loaded rows below are never wiped.
          <div className="admin-error-banner" role="alert" data-testid="users-error-banner">
            <p>
              {t('Could not load users: ')}
              {apiError.message}
            </p>
            {apiError.code === 'INVALID_CURSOR' ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="users-start-over"
                onClick={startOver}
              >
                {t('Start over')}
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
                {t('Retry')}
              </Button>
            )}
          </div>
        ) : null}
        {items.length === 0 ? (
          <p data-testid="admin-users-empty">{t('No users exist yet.')}</p>
        ) : (
          <>
            <Table aria-label={t('Users')} scrollLabel="Users table" data-testid="admin-users-list">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('Email')}</TableHead>
                  <TableHead scope="col">{t('Name')}</TableHead>
                  <TableHead scope="col">{t('Status')}</TableHead>
                  <TableHead scope="col">{t('Created')}</TableHead>
                  <TableHead scope="col">{t('Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <UserRow
                    key={item.id}
                    item={item}
                    isCurrentUser={item.id === sessionQuery.data?.userId}
                    busy={resetMutation.isPending || statusMutation.isPending}
                    onReset={() => void resetPassword(item.id)}
                    onStatusChange={(status) => void changeStatus(item.id, status)}
                  />
                ))}
              </TableBody>
            </Table>
            {query.hasNextPage ? (
              <div className="admin-pagination">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="admin-users-load-more"
                  onClick={() => {
                    void query.fetchNextPage();
                  }}
                  loading={query.isFetchingNextPage}
                  disabled={query.isFetchingNextPage}
                >
                  {t('Load more')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </main>
  );
}

function UserRow({
  item,
  isCurrentUser,
  busy,
  onReset,
  onStatusChange,
}: {
  readonly item: UserListItem;
  readonly isCurrentUser: boolean;
  readonly busy: boolean;
  readonly onReset: () => void;
  readonly onStatusChange: (status: 'active' | 'banned') => void;
}): ReactElement {
  const t = useT();
  return (
    <TableRow data-testid="admin-user-row" data-user-id={item.id}>
      <TableCell data-label={t('Email')} className="admin-user-row-email">
        {item.email}
      </TableCell>
      <TableCell data-label={t('Name')}>{item.displayName ?? '—'}</TableCell>
      <TableCell data-label={t('Status')}>
        <span className={`admin-user-status admin-user-status-${item.status}`}>
          {t(item.status)}
        </span>
      </TableCell>
      <TableCell data-label={t('Created')}>
        <LocalDateTime value={item.createdAt} />
      </TableCell>
      <TableCell>
        <div className="admin-user-row-actions">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onReset}>
            {t('Reset password')}
          </Button>
          {isCurrentUser ? null : item.status === 'active' ? (
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => onStatusChange('banned')}
            >
              {t('Deactivate')}
            </Button>
          ) : item.status === 'banned' ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onStatusChange('active')}
            >
              {t('Reactivate')}
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}
