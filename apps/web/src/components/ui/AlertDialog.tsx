// AlertDialog primitive — inline confirmation panel composed from the
// existing Alert + Button primitives (no native <dialog>, no new
// dependency). CAP-043 Slice 3: the confirm-delete flow needs a
// destructive-action confirmation; per the architecture rules the visual
// style stays in tokens.css via the existing `.alert*` / `.btn` classes,
// so this component is pure composition.
//
// Presentational only: the caller owns `open` and what "confirm" does.
// Cancel and confirm are plain buttons with distinct test ids so tests
// can drive the decision without DOM guessing.
//
// Slice 3 fix H8: an optional inline `error` slot (rendered as a danger
// Alert between the message and the actions) so a failed confirm is
// visible INSIDE the dialog, and `confirmDisabled` so the caller can
// block a second submit while the mutation is pending.
//
// Slice 3 fix H12 (dialog semantics + markup validity): the panel carries
// role="alertdialog" + aria-modal="true" + an accessible name (the `name`
// prop — a string, so the name is stable, not derived from DOM content),
// Escape cancels, and initial focus lands on the CANCEL button (the
// non-destructive choice), Tab is trapped inside the panel, and focus is
// restored to the trigger when the dialog closes. The error slot is a
// sibling of the main Alert, never nested inside its `<p>` — a div/Alert
// cannot legally sit inside a `<p>`, and the storage guard test would catch
// it.
import { useEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Alert } from './Alert';
import { Button } from './Button';

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
  error,
  onConfirm,
  onCancel,
}: AlertDialogProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[data-testid="alert-dialog-cancel"]')?.focus();

    return () => {
      if (restoreFocusRef.current?.isConnected) {
        restoreFocusRef.current.focus();
      }
      restoreFocusRef.current = null;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      className="alert-dialog"
      data-testid="alert-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label={name}
      onKeyDown={handleKeyDown}
    >
      <Alert variant="danger" title={title}>
        {children}
      </Alert>
      {error !== undefined && error !== null ? (
        <Alert variant="danger" testId="alert-dialog-error">
          {error}
        </Alert>
      ) : null}
      <div className="alert-dialog-actions">
        <Button variant="secondary" size="sm" onClick={onCancel} data-testid="alert-dialog-cancel">
          {cancelLabel}
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={onConfirm}
          disabled={confirmDisabled}
          data-testid="alert-dialog-confirm"
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
