import { useT } from '../../infrastructure/i18n/locale';
import { Trash2 } from 'lucide-react';
// apps/web — DeleteMessageButton.
//
// CAP-043 Slice 3 / AC 15 + AC 16. Opens the ConfirmDeleteDialog; only
// the confirmed path fires the mutation. Cancel sends nothing. On the
// 204 the mutation hook removes the row from the inbox cache
// (structural setQueryData — D-CAP-041-1), so this component holds only
// the dialog's open state.
//
// Slice 3 fix H8: a failed delete is no longer user-silent and no longer
// closes the dialog. The dialog's open state is now tied to SUCCESS —
// per-call callbacks on `mutate` close it only when the request lands,
// and an inline error shows inside the dialog otherwise; Confirm is
// disabled while the request is pending.
//
// Slice 3 fix H12: the trigger carries an accessible name that includes
// the subject, so a screen-reader roster of row actions distinguishes
// which message "Delete" targets.
import { useState, type ReactElement } from 'react';
import type { MessageFolder, MessageListItem } from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { useDeleteMessageMutation } from './mailbox-queries';
import { ApiError } from '../../infrastructure/api/errors';

export interface DeleteMessageButtonProps {
  readonly mailboxId: string;
  readonly folder?: MessageFolder;
  readonly message: MessageListItem;
}

export function DeleteMessageButton({
  mailboxId,
  folder = 'inbox',
  message,
}: DeleteMessageButtonProps): ReactElement {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const deleteMessage = useDeleteMessageMutation();

  // H12: subject-qualified accessible name; a bare "Delete" next to every
  // row is indistinguishable in the accessibility tree.
  const triggerLabel =
    message.subject !== ''
      ? t('Delete message: {value0}', { value0: message.subject })
      : 'Delete message';

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="inbox-delete-button"
        aria-label={triggerLabel}
        data-testid="inbox-delete-button"
        disabled={deleteMessage.isPending}
        onClick={() => {
          // H8: a fresh open starts from a clean error state.
          setErrorMessage(null);
          setConfirmOpen(true);
        }}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <ConfirmDeleteDialog
        open={confirmOpen}
        subject={message.subject}
        errorMessage={errorMessage}
        confirmDisabled={deleteMessage.isPending}
        onCancel={() => {
          setConfirmOpen(false);
        }}
        onConfirm={() => {
          // H8: clear the stale error, then fire. The dialog closes only
          // on success (per-call callbacks); a rejection keeps it open
          // with the failure shown inline. The hook-level onError still
          // runs for the cache + console.warn — these callbacks are
          // purely the dialog's UI state.
          setErrorMessage(null);
          deleteMessage.mutate(
            { mailboxId, messageId: message.id, folder },
            {
              onSuccess: () => {
                setConfirmOpen(false);
              },
              onError: (error) => {
                const code = error instanceof ApiError ? error.code : 'UNKNOWN';
                setErrorMessage(
                  code === 'UNKNOWN'
                    ? 'The request failed. Try again.'
                    : `The request failed (${code}). Try again.`,
                );
              },
            },
          );
        }}
      />
    </>
  );
}
