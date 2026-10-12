import { InitialMailboxAssignments, UserMailboxAccessPanel } from './UserMailboxAccessPanel';
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
import { EditorDialog } from '../../components/ui/EditorDialog';
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

type UserAction =
  | { readonly kind: 'create' }
  | { readonly kind: 'reset'; readonly user: UserListItem }
  | { readonly kind: 'status'; readonly user: UserListItem; readonly status: 'active' | 'banned' };

function UsersContent(): ReactElement {
  const t = useT();
  const queryClient = useQueryClient();
  // Fix (a): the reset target must match the hook's userId-scoped key.
  const sessionQuery = authSessionQuery();
  const query = usersInfiniteQuery();
  const createMutation = useCreateAdminUserMutation();
  const resetMutation = useResetAdminUserPasswordMutation();
  const statusMutation = useUpdateAdminUserStatusMutation();
  const [action, setAction] = useState<UserAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [accessUser, setAccessUser] = useState<UserListItem | null>(null);
  const [oneTimePassword, setOneTimePassword] = useState<{
    readonly email: string;
    readonly password: string;
    readonly expiresAt: string;
  } | null>(null);
  const [mutationError, setMutationError] = useState<ApiError | null>(null);

  const busy = createMutation.isPending || resetMutation.isPending || statusMutation.isPending;
  const closeAction = (): void => {
    if (busy) return;
    setAction(null);
    setOneTimePassword(null);
    setMutationError(null);
    setEmail('');
    setDisplayName('');
    setMailboxIds([]);
    createMutation.reset();
    resetMutation.reset();
    statusMutation.reset();
  };

  const submitCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setMutationError(null);
    try {
      const created = await createMutation.mutateAsync({
        email,
        ...(mailboxIds.length === 0 ? {} : { mailboxIds }),
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      });
      setOneTimePassword({
        email: created.email,
        password: created.initialPassword,
        expiresAt: created.initialPasswordExpiresAt,
      });
      setEmail('');
      setDisplayName('');
      setMailboxIds([]);
    } catch (cause) {
      setMutationError(
        cause instanceof ApiError ? cause : new ApiError('UNKNOWN', 'Could not create user', 500),
      );
    }
  };

  const resetPassword = async (user: UserListItem): Promise<void> => {
    setMutationError(null);
    try {
      const reset = await resetMutation.mutateAsync(user.id);
      setOneTimePassword({
        email: user.email,
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
      setAction(null);
      setNotice(t(status === 'active' ? 'Account restored.' : 'Account deactivated.'));
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
      <PageHeader
        title={t('Users')}
        actions={
          <Button
            onClick={() => {
              setMutationError(null);
              setAction({ kind: 'create' });
            }}
          >
            {t('Create account')}
          </Button>
        }
      />
      {notice !== null ? (
        <p role="status" className="admin-success">
          {notice}
        </p>
      ) : null}
      <EditorDialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open) closeAction();
        }}
        title={t(
          oneTimePassword !== null
            ? 'Initial password'
            : action?.kind === 'reset'
              ? 'Reset password'
              : action?.kind === 'status'
                ? action.status === 'banned'
                  ? 'Deactivate account'
                  : 'Restore account'
                : 'Create account',
        )}
        description={
          oneTimePassword !== null
            ? oneTimePassword.email
            : action?.kind === 'create'
              ? t('The generated initial password is shown once and expires after 24 hours.')
              : (action?.user.email ?? '')
        }
        compact={action?.kind !== 'create' || oneTimePassword !== null}
      >
        {oneTimePassword !== null ? (
          <div className="admin-dialog-form">
            <p>{t('Copy this password now. It will not be shown again.')}</p>
            <p data-testid="admin-one-time-password">
              <code>{oneTimePassword.password}</code>
            </p>
            <p>
              {t('Expires: ')}
              <LocalDateTime value={oneTimePassword.expiresAt} />
            </p>
            <div className="admin-dialog-actions">
              <Button onClick={closeAction}>{t('Done')}</Button>
            </div>
          </div>
        ) : action?.kind === 'create' ? (
          <form
            onSubmit={(event) => void submitCreate(event)}
            className="admin-dialog-form admin-create-user-form"
            data-testid="admin-create-user-form"
            noValidate
          >
            <fieldset disabled={createMutation.isPending}>
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
              <InitialMailboxAssignments
                selected={mailboxIds}
                onChange={setMailboxIds}
                disabled={createMutation.isPending}
              />
            </fieldset>
            {mutationError !== null ? (
              <div
                className="admin-error-banner"
                role="alert"
                data-testid="admin-user-mutation-error"
              >
                <p>{mutationError.message}</p>
                <span data-testid="error-code">{mutationError.code}</span>
              </div>
            ) : null}
            <div className="admin-dialog-actions">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeAction}>
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                loading={createMutation.isPending}
                disabled={createMutation.isPending || email.trim() === ''}
              >
                {createMutation.isPending ? t('Creating…') : t('Create account')}
              </Button>
            </div>
          </form>
        ) : action !== null ? (
          <div className="admin-dialog-form">
            <p>
              {t(
                action.kind === 'reset'
                  ? 'Resetting the password ends existing sessions. A new initial password will be shown once.'
                  : action.status === 'banned'
                    ? 'Deactivating this account ends its sessions and prevents sign-in.'
                    : 'Restore this account so the user can sign in again.',
              )}
            </p>
            <div className="admin-dialog-actions">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeAction}>
                {t('Cancel')}
              </Button>
              <Button
                variant={
                  action.kind === 'status' && action.status === 'banned' ? 'danger' : 'primary'
                }
                loading={resetMutation.isPending || statusMutation.isPending}
                disabled={resetMutation.isPending || statusMutation.isPending}
                onClick={() =>
                  action.kind === 'reset'
                    ? void resetPassword(action.user)
                    : void changeStatus(action.user.id, action.status)
                }
              >
                {t(
                  action.kind === 'reset'
                    ? 'Reset password'
                    : action.status === 'banned'
                      ? 'Deactivate'
                      : 'Restore',
                )}
              </Button>
            </div>
          </div>
        ) : null}
        {mutationError !== null && action?.kind !== 'create' ? (
          <div className="admin-error-banner" role="alert" data-testid="admin-user-mutation-error">
            <p>{mutationError.message}</p>
            <span data-testid="error-code">{mutationError.code}</span>
          </div>
        ) : null}
      </EditorDialog>
      {accessUser !== null ? (
        <UserMailboxAccessPanel
          key={accessUser.id}
          user={accessUser}
          onClose={() => setAccessUser(null)}
        />
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
                    onMailboxAccess={() => setAccessUser(item)}
                    onReset={() => {
                      setMutationError(null);
                      setAction({ kind: 'reset', user: item });
                    }}
                    onStatusChange={(status) => {
                      setMutationError(null);
                      setAction({ kind: 'status', user: item, status });
                    }}
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
  onMailboxAccess,
  onStatusChange,
}: {
  readonly item: UserListItem;
  readonly isCurrentUser: boolean;
  readonly busy: boolean;
  readonly onReset: () => void;
  readonly onMailboxAccess: () => void;
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
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || item.status !== 'active'}
            onClick={onMailboxAccess}
          >
            {t('Mailbox access')}
          </Button>
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
