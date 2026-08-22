// Spinner primitive — accessible loading indicator.
// CAP-041 uses it inside the wizard actions and inside buttons that
// trigger a mutation. Always carry `aria-label` so a screen reader
// hears "Loading" rather than silence.
import type { ReactElement } from 'react';

export interface SpinnerProps {
  readonly label?: string;
}

export function Spinner({ label = 'Loading' }: SpinnerProps): ReactElement {
  return <span className="spinner" role="status" aria-label={label} data-testid="spinner" />;
}
