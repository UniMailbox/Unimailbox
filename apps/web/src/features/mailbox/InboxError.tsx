// apps/web — InboxError.
//
// CAP-043 Slice 1. Error state for the inbox-list page. Mirrors
// <MailboxError /> (the mailbox-list page's error surface) so the two
// share the same retry contract: a single button that calls `onRetry`,
// no auto-retry (R-API-002: 4xx is deterministic; the operator must
// retry).
//
// The error panel shows the message first and the machine code as a
// sub-line. INVALID_CURSOR (R-API-005) surfaces the same way as every
// other 4xx — the retry button re-issues the first-page GET, which is
// the only valid recovery for a tampered cursor.
import type { ReactElement } from 'react';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Card } from '../../components/ui/Card';

export interface InboxErrorProps {
  readonly message: string;
  readonly code: string;
  readonly onRetry: () => void;
}

export function InboxError({ message, code, onRetry }: InboxErrorProps): ReactElement {
  return (
    <main className="auth-page" data-testid="inbox-error">
      <Card title="Could not load inbox" description="The inbox list is unavailable.">
        <ErrorPanel
          message={message}
          code={code}
          onRetry={onRetry}
          retryLabel="Retry"
          testId="inbox-error-panel"
        />
      </Card>
    </main>
  );
}