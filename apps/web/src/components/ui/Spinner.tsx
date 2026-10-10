// Spinner primitive — accessible loading indicator.
// CAP-041 uses it inside the wizard actions and inside buttons that
// trigger a mutation. Always carry `aria-label` so a screen reader
// hears "Loading" rather than silence.
import type { ReactElement } from 'react';
import { useT } from '../../infrastructure/i18n/locale';

export interface SpinnerProps {
  readonly label?: string;
  readonly decorative?: boolean;
}

export function Spinner({ label, decorative = false }: SpinnerProps): ReactElement {
  const t = useT();
  return (
    <span
      className="spinner"
      role={decorative ? undefined : 'status'}
      aria-label={decorative ? undefined : (label ?? t('Loading…'))}
      aria-hidden={decorative || undefined}
      data-testid="spinner"
    />
  );
}
