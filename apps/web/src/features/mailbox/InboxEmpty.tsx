// apps/web — InboxEmpty.
//
// CAP-043 Slice 1. Empty state for the inbox. The copy is intentionally
// short — the user expects mail here, so a long explainer would feel
// like an error. Pure presentational; no fetching.
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';

export function InboxEmpty(): ReactElement {
  return (
    <Card title="Nothing here yet" description="When new mail arrives, it shows up here.">
      <p data-testid="inbox-empty">No messages in this mailbox yet.</p>
    </Card>
  );
}