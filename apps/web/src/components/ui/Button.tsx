// shadcn/ui-style button primitive.
// CAP-001 shipped the basic primary button to prove the design-token
// pipeline. CAP-041 extends it with visual variants so the wizard can
// render a "ghost" retry button alongside the primary "Continue" CTA
// without leaking the visual style into component files.
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'btn',
  secondary: 'btn btn-secondary',
  ghost: 'btn btn-ghost',
  danger: 'btn btn-danger',
};

const sizeClass: Record<ButtonSize, string> = {
  md: 'btn-md',
  sm: 'btn-sm',
};

export function Button({
  children,
  type = 'button',
  disabled,
  variant = 'primary',
  size = 'md',
  className,
  ...rest
}: ButtonProps): ReactElement {
  const classes = [variantClass[variant], sizeClass[size], className].filter(Boolean).join(' ');
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={rest['aria-busy']}
      className={classes}
    >
      {children}
    </button>
  );
}
