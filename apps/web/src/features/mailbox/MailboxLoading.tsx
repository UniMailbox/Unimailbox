// apps/web — MailboxLoading.
//
// CAP-042 (Batch 5) AC 20. Shared loading state for the authorized
// mailbox shell. Used by MailboxShell when its `authSessionQuery` has
// not yet hydrated (rare under normal navigation — the router's
// `beforeLoad` warms the cache — but reachable on a cold reload that
// somehow bypasses the guard).
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';

export function MailboxLoading(): ReactElement {
  return (
    <main className="auth-page" data-testid="mailbox-loading">
      <Card title="Loading mailbox" description="Resuming your mailbox state.">
        <Spinner label="Loading mailbox" />
      </Card>
    </main>
  );
}
