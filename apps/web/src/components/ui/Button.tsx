import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Button as Primitive } from './shadcn/button';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
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
  ...props
}: ButtonProps): ReactElement {
  return (
    <Primitive
      {...props}
      type={type}
      variant={variants[variant]}
      size={size === 'md' ? 'default' : 'sm'}
    />
  );
}
