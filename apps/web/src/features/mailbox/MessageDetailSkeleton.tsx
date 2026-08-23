// apps/web — MessageDetailSkeleton.
//
// CAP-043 Slice 2 (AC 11). Loading state for the message-detail page.
// A header block (subject + meta) and a body block mirror the detail
// layout so the swap to the real message is visually seamless. Pure
// presentational; the sibling InboxListSkeleton follows the same
// pattern.
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';

export function MessageDetailSkeleton(): ReactElement {
  return (
    <main className="mailbox-shell" data-testid="message-detail-skeleton">
      <Card title="Loading message" description="Fetching this message and its thread.">
        <div className="message-detail-skeleton-header" data-testid="message-detail-skeleton-header" />
        <div className="message-detail-skeleton-body" data-testid="message-detail-skeleton-body" />
      </Card>
    </main>
  );
}
