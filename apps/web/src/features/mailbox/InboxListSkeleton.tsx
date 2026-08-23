// apps/web — InboxListSkeleton.
//
// CAP-043 Slice 1. Loading state for the inbox-list page. Five skeleton
// rows mirror the per-message layout (subject + meta line) so the swap
// to the real list is visually seamless. Pure presentational.
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';

export function InboxListSkeleton(): ReactElement {
  return (
    <main className="auth-page" data-testid="inbox-list-skeleton">
      <Card title="Loading inbox" description="Fetching messages for this mailbox.">
        <ul className="inbox-list">
          <li className="inbox-list-row-skeleton" data-testid="inbox-list-row-skeleton" />
          <li className="inbox-list-row-skeleton" data-testid="inbox-list-row-skeleton" />
          <li className="inbox-list-row-skeleton" data-testid="inbox-list-row-skeleton" />
          <li className="inbox-list-row-skeleton" data-testid="inbox-list-row-skeleton" />
          <li className="inbox-list-row-skeleton" data-testid="inbox-list-row-skeleton" />
        </ul>
      </Card>
    </main>
  );
}