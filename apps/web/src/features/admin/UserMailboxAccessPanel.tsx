import { useState, type ReactElement } from 'react';
import type {
  AdminUserMailboxItem,
  AdminUserMailboxAccessRequest,
  UserListItem,
} from '@unimailbox/contracts';
import { useT } from '../../infrastructure/i18n/locale';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { ApiError } from '../../infrastructure/api/errors';
import { useSetUserMailboxAccess, useUserMailboxAccess } from './user-mailbox-queries';

export function UserMailboxAccessPanel({
  user,
  onClose,
}: {
  user: UserListItem;
  onClose: () => void;
}): ReactElement {
  const t = useT();
  const query = useUserMailboxAccess(user.id);
  const mutation = useSetUserMailboxAccess(user.id);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const save = async (
    mailboxId: string,
    role: AdminUserMailboxAccessRequest['role'],
  ): Promise<void> => {
    setError(null);
    setSaved(false);
    try {
      await mutation.mutateAsync({ mailboxId, role });
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError('UNKNOWN', 'Could not save mailbox access', 500),
      );
    }
  };
  return (
    <Card title={t('Mailbox access')} description={user.email}>
      <div className="admin-user-mailbox-access" data-testid="admin-user-mailbox-access">
        <p>
          {t(
            'Mailbox permissions are assigned by administrators. Full access includes reading, sending and organizing messages.',
          )}
        </p>
        <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
          {t('Close')}
        </Button>
        {query.isPending ? <ContentSkeleton variant="list" /> : null}
        {query.error ? (
          <ErrorPanel
            message={query.error.message}
            code={query.error instanceof ApiError ? query.error.code : 'UNKNOWN'}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {error ? <ErrorPanel message={error.message} code={error.code} /> : null}
        {saved ? <p role="status">{t('Mailbox access saved.')}</p> : null}
        {query.data?.length === 0 ? <p>{t('No mailboxes are available for assignment.')}</p> : null}
        <div className="admin-mailbox-access-list">
          {query.data?.map((mailbox) => (
            <MailboxAccessRow
              key={`${mailbox.id}:${mailbox.role}`}
              mailbox={mailbox}
              busy={mutation.isPending || query.isFetching}
              onSave={(role) => void save(mailbox.id, role)}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function MailboxAccessRow({
  mailbox,
  busy,
  onSave,
}: {
  mailbox: AdminUserMailboxItem;
  busy: boolean;
  onSave: (role: AdminUserMailboxAccessRequest['role']) => void;
}): ReactElement {
  const t = useT();
  const [role, setRole] = useState(mailbox.role ?? 'none');
  const owner = mailbox.role === 'owner';
  return (
    <div className="admin-mailbox-access-row">
      <label htmlFor={`mailbox-access-${mailbox.id}`}>{mailbox.address}</label>
      {owner ? (
        <span>{t('Owner — full access')}</span>
      ) : (
        <>
          <select
            id={`mailbox-access-${mailbox.id}`}
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
            disabled={busy}
          >
            <option value="none">{t('No access')}</option>
            <option value="viewer">{t('View only')}</option>
            <option value="sender">{t('View and send')}</option>
            <option value="admin">{t('Full mailbox access')}</option>
          </select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy || role === (mailbox.role ?? 'none')}
            onClick={() =>
              onSave(role === 'none' ? null : (role as AdminUserMailboxAccessRequest['role']))
            }
          >
            {t('Save')}
          </Button>
        </>
      )}
    </div>
  );
}

export function InitialMailboxAssignments({
  selected,
  onChange,
  disabled,
}: {
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}): ReactElement {
  const t = useT();
  const query = useUserMailboxAccess();
  return (
    <fieldset disabled={disabled} className="admin-initial-mailbox-assignments">
      <legend>{t('Assign mailboxes')}</legend>
      <p>
        {t(
          'Selected mailboxes receive full access by default. You can change permissions after creating the account.',
        )}
      </p>
      {query.isPending ? <ContentSkeleton variant="list" /> : null}
      {query.error ? (
        <ErrorPanel
          message={query.error.message}
          code={query.error instanceof ApiError ? query.error.code : 'UNKNOWN'}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data?.length === 0 ? <p>{t('No mailboxes are available for assignment.')}</p> : null}
      <div className="admin-mailbox-assignment-options">
        {query.data?.map((mailbox) => (
          <label key={mailbox.id}>
            <input
              type="checkbox"
              checked={selected.includes(mailbox.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, mailbox.id]
                    : selected.filter((id) => id !== mailbox.id),
                )
              }
            />
            {mailbox.address}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
