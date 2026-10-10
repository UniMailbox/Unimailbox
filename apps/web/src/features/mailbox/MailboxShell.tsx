import { useT } from '../../infrastructure/i18n/locale';
// apps/web — MailboxShell.
//
// CAP-042 (Batch 5) AC 20. The authorized mailbox shell. Reached only
// after `/mailbox`'s `beforeLoad` confirms a valid session via
// `queryClient.ensureQueryData(authQueryKeys.session(), fetchAuthSession)`;
// the same cache feeds this component's read via `authSessionQuery`,
// so the descriptor is already in memory by the time we render (one
// HTTP GET per navigation, not two — D-CAP-041-1).
//
// CAP-042 Batch 8 (L-4 fix): when the descriptor resolves to `null`
// (session expired mid-render, the cookie was cleared between
// `beforeLoad` and the component mount), we now render
// `<Unauthorized variant="expired" />` instead of the infinite
// `<MailboxLoading />` spinner. The router's `beforeLoad` *should*
// have redirected to `/login` instead, but if the session was valid
// at guard time and revoked between guard and render, we surface an
// actionable error rather than an indefinite spinner.
//
// The full inbox + thread + compose shell lands with CAP-043/044. For
// Batch 5 we render the placeholder body so a reviewer can navigate
// /login → /mailbox end-to-end and exercise the LogoutButton.
import type { ReactElement } from 'react';
import { authSessionQuery } from '../auth/auth-queries';
import { LogoutButton } from '../auth/LogoutButton';
import { Unauthorized } from '../auth/Unauthorized';
import { Card } from '../../components/ui/Card';
import { MailboxLoading } from './MailboxLoading';

export function MailboxShell(): ReactElement {
  const t = useT();
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    // Cache is empty (rare: a fresh navigation with a never-loaded
    // session descriptor). Show the loading state and let the query
    // hydrate. In practice the router's `beforeLoad` already ran
    // `ensureQueryData` so this branch is unreachable under normal
    // navigation.
    return <MailboxLoading />;
  }
  const descriptor = sessionQuery.data;
  // CAP-042 Batch 8 (L-4 fix): the router's `beforeLoad` guarantees
  // `descriptor !== null` under normal navigation. The `null` branch
  // here is the deeper fallback for the case where the session was
  // valid at guard time but revoked before this component mounted —
  // surface an actionable "Session expired" view rather than a
  // permanent spinner.
  if (descriptor === null) {
    return <Unauthorized variant="expired" />;
  }
  return (
    <main className="mailbox-shell" data-testid="mailbox-shell">
      <header className="mailbox-header">
        <h1 className="mailbox-title">{t('Mailbox')}</h1>
        <div className="mailbox-header-meta">
          <span data-testid="mailbox-user-email">{descriptor.email}</span>
          <LogoutButton />
        </div>
      </header>
      <Card
        title={t('Authorized')}
        description={t('You are signed in. The full inbox lands with CAP-043.')}
      >
        <p data-testid="mailbox-placeholder">
          {t(
            'Authorized mailbox shell. Inbox, threads, and compose land with CAP-043 and CAP-044.',
          )}
        </p>
        {descriptor.displayName !== null ? (
          <p className="mailbox-subtitle" data-testid="mailbox-display-name">
            {t('Display name: ')}
            {descriptor.displayName}
          </p>
        ) : null}
      </Card>
    </main>
  );
}
