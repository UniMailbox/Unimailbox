// apps/web — ConfirmDeleteDialog.
//
// CAP-043 Slice 3 / AC 15-16: presentational wrapper around the
// AlertDialog primitive carrying the delete copy. The semantics of a
// per-user soft delete (D-CAP-043-B) are user-visible — "other members
// keep their copy" — so the copy states them instead of a generic
// "are you sure". Purely presentational: the parent owns open state and
// both callbacks.
//
// Slice 3 fix H8: the dialog surfaces the delete failure inline
// (`errorMessage`) and can disable Confirm while the request is pending
// (`confirmDisabled`); the parent decides when it closes.
import type { ReactElement } from 'react';
import { AlertDialog } from '../../components/ui/AlertDialog';

export interface ConfirmDeleteDialogProps {
  readonly open: boolean;
  /** Message subject shown in the confirmation copy. */
  readonly subject: string;
  /** H8: inline failure copy; the dialog stays open while this is set. */
  readonly errorMessage?: string | null | undefined;
  /** H8: true while the DELETE request is in flight. */
  readonly confirmDisabled?: boolean | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDeleteDialog({
  open,
  subject,
  errorMessage,
  confirmDisabled,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps): ReactElement | null {
  return (
    <AlertDialog
      open={open}
      name="Delete this message?"
      title="Delete this message?"
      confirmLabel="Delete"
      confirmDisabled={confirmDisabled}
      error={
        errorMessage !== undefined && errorMessage !== null
          ? `The message was not deleted. ${errorMessage}`
          : undefined
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      Delete “{subject}” from your inbox? This removes it for you only — other members of the
      mailbox keep their copy.
    </AlertDialog>
  );
}
