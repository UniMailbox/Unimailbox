import { useT } from '../../infrastructure/i18n/locale';
import { Star } from 'lucide-react';
// apps/web — StarButton.
//
// CAP-043 Slice 3 / AC 13 + AC 16. The inbox row's star toggle. The
// optimistic flip lives in the mutation hook
// (`useToggleMessageStarMutation` writes the cache in `onMutate`), so
// this component only renders the CURRENT cache value and fires the
// mutation — the row re-renders starred the same tick the user clicks,
// and the hook rolls it back if the request fails.
//
// `aria-pressed` exposes the toggle state to assistive tech; the label
// names the action in the direction the click will go.
import type { ReactElement } from 'react';
import type { MessageFolder, MessageListItem } from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { useToggleMessageStarMutation } from './mailbox-queries';

export interface StarButtonProps {
  readonly mailboxId: string;
  readonly folder?: MessageFolder;
  readonly message: MessageListItem;
}

export function StarButton({
  mailboxId,
  folder = 'inbox',
  message,
}: StarButtonProps): ReactElement {
  const t = useT();
  const toggleStar = useToggleMessageStarMutation();
  const isStarred = message.isStarred === 1;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="inbox-star-button"
      data-testid="inbox-star-button"
      aria-pressed={isStarred}
      aria-label={isStarred ? t('Unstar message') : t('Star message')}
      disabled={toggleStar.isPending}
      onClick={() => {
        toggleStar.mutate({ mailboxId, messageId: message.id, folder });
      }}
    >
      <Star
        className={isStarred ? 'fill-current text-amber-500' : 'text-muted-foreground'}
        aria-hidden="true"
      />
    </Button>
  );
}
