// apps/web — MailboxError.
//
// CAP-042 (Batch 5) AC 20. Shared error state for the authorized
// mailbox shell. Used by MailboxShell when `authSessionQuery` returns
// an error that is not a 401 (network failure, 5xx). Per R-API-002
// the machine-readable `code` is surfaced alongside the human message.
//
// The 401 → redirect path is owned by the router's `beforeLoad`; this
// view covers everything else.
import type { ReactElement } from 'react';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Card } from '../../components/ui/Card';

export interface MailboxErrorProps {
  readonly message: string;
  readonly code: string;
  readonly onRetry: () => void;
}

export function MailboxError({ message, code, onRetry }: MailboxErrorProps): ReactElement {
  return (
    <main className="auth-page" data-testid="mailbox-error">
      <Card title="Could not load mailbox" description="The mailbox state is unavailable.">
        <ErrorPanel
          message={message}
          code={code}
          onRetry={onRetry}
          retryLabel="Retry"
          testId="mailbox-error-panel"
        />
      </Card>
    </main>
  );
}
