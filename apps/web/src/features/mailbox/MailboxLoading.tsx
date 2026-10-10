import { useT } from '../../infrastructure/i18n/locale';
// apps/web — MailboxLoading.
//
// CAP-042 (Batch 5) AC 20. Shared loading state for the authorized
// mailbox shell. Used by MailboxShell when its `authSessionQuery` has
// not yet hydrated (rare under normal navigation — the router's
// `beforeLoad` warms the cache — but reachable on a cold reload that
// somehow bypasses the guard).
import type { ReactElement } from 'react';
import { Spinner } from '../../components/ui/Spinner';

export function MailboxLoading(): ReactElement {
  const t = useT();
  return (
    <main
      className="flex min-h-48 items-center justify-center"
      data-testid="mailbox-loading"
      aria-busy="true"
    >
      <Spinner label={t('Loading mailbox')} />
    </main>
  );
}
