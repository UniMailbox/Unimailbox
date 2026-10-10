import { useT } from '../../infrastructure/i18n/locale';
// apps/web — InboxEmpty.
//
// CAP-043 Slice 1. Empty state for the inbox. The copy is intentionally
// short — the user expects mail here, so a long explainer would feel
// like an error. Pure presentational; no fetching.
import type { ReactElement } from 'react';
import { Inbox } from 'lucide-react';

export interface InboxEmptyProps {
  readonly folderLabel?: string;
}

export function InboxEmpty({ folderLabel = 'Inbox' }: InboxEmptyProps): ReactElement {
  const t = useT();
  const isInbox = folderLabel === 'Inbox';
  return (
    <div className="empty-state">
      <Inbox className="size-8 text-muted-foreground" aria-hidden="true" />
      <p data-testid="inbox-empty">
        {isInbox
          ? t('No messages in this mailbox yet.')
          : t('No messages in this {folder} yet.', { folder: t(folderLabel) })}
      </p>
    </div>
  );
}
