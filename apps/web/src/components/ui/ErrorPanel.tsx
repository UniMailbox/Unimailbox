// ErrorPanel — composes Alert + Retry button.
// R-API-002: the human message comes first, the machine code is shown
// as a sub-line. AC #15: no auto-retry on 4xx other than 409/429; the
// retry button is the operator's manual lever. AC #16: secrets are never
// echoed back; the error message is the API's, not the form's.
import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button';

export interface ErrorPanelProps {
  readonly message: ReactNode;
  readonly code?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly testId?: string;
}

export function ErrorPanel({
  message,
  code,
  onRetry,
  retryLabel = 'Retry',
  testId,
}: ErrorPanelProps): ReactElement {
  return (
    <div
      className="error-panel"
      role="alert"
      data-testid={testId ?? 'error-panel'}
    >
      <p className="error-panel-message">{message}</p>
      {code !== undefined ? (
        <span className="error-panel-code" data-testid="error-code">
          {code}
        </span>
      ) : null}
      {onRetry !== undefined ? (
        <div className="error-panel-actions">
          <Button type="button" onClick={onRetry} variant="ghost">
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
