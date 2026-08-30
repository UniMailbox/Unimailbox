// apps/web — BrevoStep.
//
// CAP-041 / step 7. Collects the Brevo API key. R-SECRET-003: the key
// is in form state only, never echoed into a success view, never
// persisted. The submit posts the API key; the response never contains
// the key.
//
// CAP-063: skip button rendered via <SkipRemainingSetupButton /> below
// the form. R-WORKFLOW-002 reuses the existing /complete endpoint.
// Critical: the skip body must be the empty object — R-SECRET-003
// forbids leaking the API key into any other request.
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setupBrevoRequestSchema, type SetupBrevoRequest } from '@unimailbox/contracts';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setupQueryKeys } from '../setup-queries';
import {
  reclaimInstallationToken,
  useSkipRemainingSetup,
} from '../use-skip-remaining-setup';
import { SkipRemainingSetupButton } from '../SkipRemainingSetupButton';
import { SetupGuidance } from '../setup-guidance';

export function BrevoStep(): ReactElement {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const skipRemaining = useSkipRemainingSetup();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SetupBrevoRequest>({
    resolver: zodResolver(setupBrevoRequestSchema),
    defaultValues: { apiKey: '' },
  });

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    reclaimInstallationToken(navigate);
  };

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await apiClient.fetch('/api/v1/setup/brevo', {
        method: 'POST',
        body: values,
      });
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/setup/outbound-smoke' });
    } catch (error) {
      if (error instanceof ApiError) {
        setSubmitError({
          message: error.message,
          code: error.code,
          status: error.status,
        });
        return;
      }
      setSubmitError({
        message: 'Unexpected error',
        code: 'UNEXPECTED_ERROR',
        status: null,
      });
    }
  });

  const submitErrorMessage = submitError?.message ?? '';
  const submitErrorCode = submitError?.code ?? '';
  const submitErrorStatus = submitError?.status ?? null;
  const isUnauthorized = submitErrorStatus === 401;

  return (
    <Card
      title="Configure Brevo"
      description="Provide the Brevo API key for outbound email delivery."
    >
      <SetupGuidance
        purpose="Connect the provider that will send outbound email."
        prepare="A Brevo API key with permission to send transactional email."
        steps={[
          'Paste the API key into the password field.',
          'Select Save API key so the Worker can validate it with Brevo.',
        ]}
        success="The key is encrypted at rest, linked to the managed domain, and the wizard opens the outbound smoke test."
        note="The key is never shown again or returned in the API response. Do not paste it into chat, tickets, or source control."
      />
      <form onSubmit={onSubmit} noValidate>
        <Input
          id="brevo-api-key"
          type="password"
          autoComplete="off"
          label="Brevo API key"
          help="The key is stored encrypted and never returned by the API."
          error={errors.apiKey?.message}
          {...register('apiKey')}
        />
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
            type="submit"
            variant="primary"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            data-testid="brevo-submit"
          >
            {isSubmitting ? <Spinner /> : 'Save API key'}
          </Button>
        </div>
      </form>
      {skipRemaining.error !== null ? (
        <ErrorPanel
          message={skipRemaining.error.message}
          code={skipRemaining.error.code}
          retryLabel={skipRemaining.isUnauthorized ? 'Re-claim installation token' : 'Retry'}
          onRetry={
            skipRemaining.isUnauthorized
              ? handleReclaim
              : () => void skipRemaining.skip()
          }
        />
      ) : null}
      <SkipRemainingSetupButton
        onSkip={() => void skipRemaining.skip()}
        submitting={skipRemaining.submitting}
      />
    </Card>
  );
}