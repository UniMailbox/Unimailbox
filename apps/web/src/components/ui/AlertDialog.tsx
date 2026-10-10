import { useRef, type ReactElement, type ReactNode } from 'react';
import * as Dialog from './shadcn/alert-dialog';
import { Alert } from './Alert';
import { Button } from './Button';
import { useT } from '../../infrastructure/i18n/locale';
export interface AlertDialogProps {
  readonly open: boolean;
  /** Accessible name for the alertdialog (aria-label). Plain string. */
  readonly name: string;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** H8: disable Confirm while the operation is pending. */
  readonly confirmDisabled?: boolean | undefined;
  readonly confirmBusy?: boolean | undefined;
  /** H8: inline failure message; rendered as a danger Alert in the dialog. */
  readonly error?: ReactNode | undefined;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function AlertDialog({
  open,
  name,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmDisabled,
  confirmBusy,
  error,
  onConfirm,
  onCancel,
}: AlertDialogProps): ReactElement {
  const t = useT();
  const restoreFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onCancel();
      }}
    >
      <Dialog.AlertDialogContent
        aria-label={t(name)}
        aria-modal="true"
        data-testid="alert-dialog"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), [tabindex="0"]',
            ),
          );
          const first = buttons[0];
          const last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first && last) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last && first) {
            event.preventDefault();
            first.focus();
          }
        }}
        onOpenAutoFocus={() => {
          restoreFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (restoreFocus.current?.isConnected) {
            event.preventDefault();
            restoreFocus.current.focus();
          }
        }}
      >
        <Dialog.AlertDialogHeader>
          <Dialog.AlertDialogTitle>
            {typeof title === 'string' ? t(title) : title}
          </Dialog.AlertDialogTitle>
          <Dialog.AlertDialogDescription asChild>
            <div>{children}</div>
          </Dialog.AlertDialogDescription>
        </Dialog.AlertDialogHeader>
        {error !== undefined && error !== null ? (
          <Alert variant="danger" testId="alert-dialog-error">
            {error}
          </Alert>
        ) : null}
        <Dialog.AlertDialogFooter>
          <Dialog.AlertDialogCancel data-testid="alert-dialog-cancel">
            {t(cancelLabel)}
          </Dialog.AlertDialogCancel>
          <Button
            variant="danger"
            onClick={onConfirm}
            disabled={confirmDisabled}
            loading={confirmBusy ?? false}
            data-testid="alert-dialog-confirm"
          >
            {t(confirmLabel)}
          </Button>
        </Dialog.AlertDialogFooter>
      </Dialog.AlertDialogContent>
    </Dialog.AlertDialog>
  );
}
