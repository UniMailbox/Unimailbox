// Input primitive — shadcn/ui-style text input.
// CAP-041 ships the wizard form inputs. The component is intentionally
// uncontrolled — react-hook-form is the source of truth for value +
// validation. Error rendering is driven by `aria-invalid` so the
// styles downshift via the `[aria-invalid="true"]` selector in
// tokens.css.
import type {
  InputHTMLAttributes,
  ReactElement,
  ReactNode,
} from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label?: ReactNode;
  readonly error?: ReactNode;
  readonly help?: ReactNode;
  readonly id: string;
}

export function Input({
  label,
  error,
  help,
  id,
  className,
  ...rest
}: InputProps): ReactElement {
  const describedBy: string[] = [];
  if (error !== undefined) describedBy.push(`${id}-error`);
  if (help !== undefined) describedBy.push(`${id}-help`);

  return (
    <div className="wizard-field">
      {label !== undefined ? (
        <label className="input-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <input
        {...rest}
        id={id}
        className={['input', className].filter(Boolean).join(' ')}
        aria-invalid={error !== undefined ? true : undefined}
        aria-describedby={
          describedBy.length > 0 ? describedBy.join(' ') : undefined
        }
      />
      {error !== undefined ? (
        <span id={`${id}-error`} className="input-error" role="alert">
          {error}
        </span>
      ) : null}
      {/* MEDIUM (CAP-041 fix): render BOTH help and error spans when both
          are supplied so aria-describedby resolves to both ids.
          Previously the help span was suppressed when an error was
          shown, leaving the help id dangling and confusing AT. */}
      {help !== undefined ? (
        <span id={`${id}-help`} className="input-help">
          {help}
        </span>
      ) : null}
    </div>
  );
}
