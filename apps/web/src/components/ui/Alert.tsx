// Alert primitive — banner / informational message.
// R-WORKFLOW-001 / R-API-002: the wizard surfaces the machine-readable
// `code` from the API error envelope as a sub-line so the operator can
// log it. The variant controls the semantic color set; the visual
// style lives in tokens.css.
import type { ReactElement, ReactNode } from 'react';

export type AlertVariant = 'info' | 'success' | 'warning' | 'danger';

export interface AlertProps {
  readonly variant?: AlertVariant;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly code?: string;
  readonly testId?: string;
}

export function Alert({
  variant = 'info',
  title,
  children,
  code,
  testId,
}: AlertProps): ReactElement {
  return (
    <div
      className="alert"
      data-variant={variant}
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
      data-testid={testId ?? 'alert'}
    >
      {title !== undefined ? <p className="alert-title">{title}</p> : null}
      {children !== undefined ? <p className="alert-message">{children}</p> : null}
      {code !== undefined ? (
        <span className="alert-code" data-testid="alert-code">
          {code}
        </span>
      ) : null}
    </div>
  );
}
