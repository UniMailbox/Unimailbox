import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Button as Primitive } from './shadcn/button';
import { Spinner } from './Spinner';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}
const variants = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
  danger: 'destructive',
} as const;
export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps): ReactElement {
  return (
    <Primitive
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || props['aria-busy']}
      variant={variants[variant]}
      size={size === 'md' ? 'default' : 'sm'}
    >
      {loading ? <Spinner decorative /> : null}
      {children}
    </Primitive>
  );
}
