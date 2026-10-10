import { errorMessage } from '../../infrastructure/i18n/error-messages';
import { useT } from '../../infrastructure/i18n/locale';
import { useState, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input as Primitive } from './shadcn/input';
import { Label } from './shadcn/label';
import { Button } from './shadcn/button';
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label?: ReactNode;
  readonly error?: ReactNode;
  readonly help?: ReactNode;
  readonly id: string;
  readonly endAdornment?: ReactNode;
}
/** RHF remains the source of truth; password visibility follows the reference PasswordInput. */
export function Input({
  label,
  error,
  help,
  id,
  type,
  className,
  endAdornment,
  ...rest
}: InputProps): ReactElement {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const describedBy = [
    rest['aria-describedby'],
    error !== undefined && `${id}-error`,
    help !== undefined && `${id}-help`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="wizard-field">
      {label !== undefined ? (
        <Label htmlFor={id}>{typeof label === 'string' ? t(label) : label}</Label>
      ) : null}
      <div className="relative">
        <Primitive
          {...rest}
          id={id}
          type={type === 'password' && visible ? 'text' : type}
          className={type === 'password' ? `pe-10 ${className ?? ''}` : className}
          aria-invalid={error !== undefined || rest['aria-invalid']}
          aria-describedby={describedBy || undefined}
        />
        {endAdornment ? (
          <div className="absolute end-1 top-1/2 flex -translate-y-1/2 gap-0.5">{endAdornment}</div>
        ) : null}
        {type === 'password' ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute end-1 top-1/2 size-7 -translate-y-1/2"
            disabled={rest.disabled}
            aria-label={t(visible ? 'Hide password' : 'Show password')}
            aria-pressed={visible}
            onClick={() => setVisible(!visible)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </Button>
        ) : null}
      </div>
      {error !== undefined ? (
        <span id={`${id}-error`} className="input-error" role="alert">
          {typeof error === 'string'
            ? /^[A-Z_]+$/.test(error)
              ? errorMessage(error)
              : t(error)
            : error}
        </span>
      ) : null}
      {help !== undefined ? (
        <span id={`${id}-help`} className="input-help">
          {typeof help === 'string' ? t(help) : help}
        </span>
      ) : null}
    </div>
  );
}
