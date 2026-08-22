// Toast primitive — transient acknowledgement banner.
// CAP-041 uses it for "Setup complete" and similar confirmations. The
// component is presentational; the hosting page decides when to mount
// and unmount it. The wizard never builds a notification system on top
// of this — it disappears when the route transitions.
import type { ReactElement, ReactNode } from 'react';

export type ToastVariant = 'default' | 'success' | 'danger';

export interface ToastProps {
  readonly variant?: ToastVariant;
  readonly children: ReactNode;
  readonly testId?: string;
}

export function Toast({
  variant = 'default',
  children,
  testId,
}: ToastProps): ReactElement {
  return (
    <div
      className="toast"
      data-variant={variant}
      role="status"
      data-testid={testId ?? 'toast'}
    >
      {children}
    </div>
  );
}
