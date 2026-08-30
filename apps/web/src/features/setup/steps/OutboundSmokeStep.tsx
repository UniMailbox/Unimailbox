// apps/web — OutboundSmokeStep.
//
// CAP-041 / step 8. Submits the outbound smoke test. On success the
// server advances the step to 'complete' (R-WORKFLOW-003); this step
// simply waits and advances to /setup/complete.
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { Alert } from '../../../components/ui/Alert';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setupQueryKeys } from '../setup-queries';
import { clearSetupSession } from '../setup-session-store';
import { SetupGuidance } from '../setup-guidance';

export function OutboundSmokeStep(): ReactElement {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    clearSetupSession();
    void navigate({ to: '/setup/claim' });
  };

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiClient.fetch('/api/v1/setup/outbound-smoke-test', {
        method: 'POST',
        body: {},
      });
      setSubmitted(true);
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/setup/complete' });
    } catch (error) {
      if (error instanceof ApiError) {
        setSubmitError({
          message: error.message,
          code: error.code,
          status: error.status,
        });
      } else {
        setSubmitError({
          message: 'Unexpected error',
          code: 'UNEXPECTED_ERROR',
          status: null,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const submitErrorMessage = submitError?.message ?? '';
  const submitErrorCode = submitError?.code ?? '';
  const submitErrorStatus = submitError?.status ?? null;
  const isUnauthorized = submitErrorStatus === 401;

  return (
    <Card title="Outbound smoke test" description="Send a real outbound email to confirm delivery.">
      <SetupGuidance
        purpose="Confirm that Brevo accepts a real outbound message from this installation."
        prepare="No additional input is required; the test is sent to the administrator email created earlier."
        steps={[
          'Confirm the administrator mailbox can receive email.',
          'Select Send outbound smoke test once.',
          'Check the administrator inbox for the test message after the provider accepts it.',
        ]}
        success="The provider acceptance advances the wizard to the final completion step."
        note="This sends a real email. Provider acceptance is recorded immediately; inbox delivery may take longer."
      />
      {submitted ? (
        <Alert variant="success" testId="outbound-success">
          Smoke test sent — the server is marking the installation complete.
        </Alert>
      ) : (
        <p className="wizard-subtitle">
          Click the button to send a test email to the administrator.
        </p>
      )}
      {submitError !== null ? (
        <ErrorPanel
          message={submitErrorMessage}
          code={submitErrorCode}
          retryLabel={isUnauthorized ? 'Re-claim installation token' : 'Retry'}
          onRetry={isUnauthorized ? handleReclaim : () => void onSubmit()}
        />
      ) : null}
      <div className="wizard-actions">
        <Button
          type="button"
          variant="primary"
          disabled={submitting}
          onClick={() => void onSubmit()}
          aria-busy={submitting}
          data-testid="outbound-submit"
        >
          {submitting ? <Spinner /> : 'Send outbound smoke test'}
        </Button>
      </div>
    </Card>
  );
}
