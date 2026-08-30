// apps/web — InboxEmpty.
//
// CAP-043 Slice 1. Empty state for the inbox. The copy is intentionally
// short — the user expects mail here, so a long explainer would feel
// like an error. Pure presentational; no fetching.
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';

export interface InboxEmptyProps {
  readonly folderLabel?: string;
}

export function InboxEmpty({ folderLabel = 'Inbox' }: InboxEmptyProps): ReactElement {
  const folder = folderLabel.toLowerCase();
  const isInbox = folderLabel === 'Inbox';
  return (
    <Card
      title="Nothing here yet"
      description={
        isInbox ? 'When new mail arrives, it shows up here.' : `No messages are in ${folder}.`
      }
    >
      <p data-testid="inbox-empty">
        {isInbox ? 'No messages in this mailbox yet.' : `No messages in this ${folder} yet.`}
      </p>
    </Card>
  );
}
