import type { ReactElement, ReactNode } from 'react';
import { Alert as Primitive, AlertTitle, AlertDescription } from './shadcn/alert';
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
    <Primitive
      variant={variant === 'danger' ? 'destructive' : 'default'}
      className={`product-alert-${variant}`}
      role={variant === 'danger' || variant === 'warning' ? 'alert' : 'status'}
      data-variant={variant}
      data-testid={testId ?? 'alert'}
    >
      {title !== undefined ? <AlertTitle>{title}</AlertTitle> : null}
      {children !== undefined ? <AlertDescription>{children}</AlertDescription> : null}
      {code !== undefined ? (
        <span className="alert-code" data-testid="alert-code">
          {code}
        </span>
      ) : null}
    </Primitive>
  );
}
