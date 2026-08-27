// apps/web — MailboxListSkeleton.
//
// CAP-043 Slice 1. Loading state for the mailbox-list page. Three
// skeleton rows so the layout is stable on slow connections. Pure
// presentational; no state, no fetching. Mirrors the structure of
// <MailboxListPage /> so the swap on hydration is visually seamless.
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';

export function MailboxListSkeleton(): ReactElement {
  return (
    <main className="auth-page" data-testid="mailbox-list-skeleton">
      <Card title="Loading mailboxes" description="Fetching your mailbox list.">
        <ul className="mailbox-list">
          <li className="mailbox-list-row-skeleton" data-testid="mailbox-list-row-skeleton" />
          <li className="mailbox-list-row-skeleton" data-testid="mailbox-list-row-skeleton" />
          <li className="mailbox-list-row-skeleton" data-testid="mailbox-list-row-skeleton" />
        </ul>
      </Card>
    </main>
  );
}
