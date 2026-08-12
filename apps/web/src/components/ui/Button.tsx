// Example shadcn/ui-style primitive — proves the design-token pipeline works.
// Real primitives (Input, Card, Dropdown, Dialog, Toast) land with Phase 1
// capabilities as they need them. CAP-001 ships exactly one.
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
}

export function Button({
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={rest['aria-busy']}
      className="btn"
    >
      {children}
    </button>
  );
}