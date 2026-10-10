import { usePersonalSettings } from '../settings/personal-settings-context';
import { useEffect, type ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { authSessionQuery } from '../auth/auth-queries';
import { mailboxListQuery } from './mailbox-queries';
import { selectDefaultMailbox } from '../../infrastructure/preferences/default-mailbox';
import { MailboxLoading } from './MailboxLoading';
import { MailboxListPage } from './MailboxListPage';

export function DefaultMailboxPage(): ReactElement {
  const navigate = useNavigate();
  const session = authSessionQuery().data;
  const query = mailboxListQuery();
  const personal = usePersonalSettings();
  const mailbox =
    session && query.data
      ? selectDefaultMailbox(query.data, session, personal.settings.preferences.defaultMailboxId)
      : undefined;
  useEffect(() => {
    if (mailbox && !personal.loading)
      void navigate({
        to: '/mailbox/$mailboxId',
        params: { mailboxId: mailbox.id },
        search: { folder: 'inbox' },
        replace: true,
      });
  }, [mailbox, navigate, personal.loading]);
  // Preserve the list's existing retry/expired/empty state when no default is available.
  return mailbox || query.isPending ? <MailboxLoading /> : <MailboxListPage />;
}
