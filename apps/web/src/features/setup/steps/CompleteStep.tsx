// apps/web — CompleteStep.
//
// CAP-041 / step 9. Final POST to /complete flips installation_state.status
// to 'complete'. R-WORKFLOW-001: the server is the source of truth; we
// only POST and show the success card.
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

export function CompleteStep(): ReactElement {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    clearSetupSession();
    void navigate({ to: '/setup/claim' });
  };

  const onSubmit = async (): Promise<void> => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await apiClient.fetch('/api/v1/setup/complete', {
        method: 'POST',
        body: {},
      });
      setCompleted(true);
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
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
    <Card
      title="Complete setup"
      description="Mark the installation complete and route the app to the dashboard."
    >
      <SetupGuidance
        purpose="Finalize installation and make the mailbox application available."
        prepare="Confirm the previous inbound and outbound smoke tests completed successfully."
        steps={[
          'Review that the setup checks and provider tests are complete.',
          'Select Complete setup to seed the default roles and finish the installation.',
          'Select Go to app after the success message appears.',
        ]}
        success="The installation status becomes complete, the administrator role is assigned, and application routes are unlocked."
        note="This is the final setup action. The setup gate will no longer redirect application routes to the wizard."
      />
      {completed ? (
        <Alert variant="success" testId="complete-success">
          Installation is complete. The app is now live.
        </Alert>
      ) : (
        <p className="wizard-subtitle">Click the button to mark the installation complete.</p>
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
        {completed ? (
          <Button
            type="button"
            variant="primary"
            onClick={() => void navigate({ to: '/' })}
            data-testid="complete-go-to-app"
          >
            Go to app
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            disabled={submitting}
            onClick={() => void onSubmit()}
            aria-busy={submitting}
            data-testid="complete-submit"
          >
            {submitting ? <Spinner /> : 'Complete setup'}
          </Button>
        )}
      </div>
    </Card>
  );
}
