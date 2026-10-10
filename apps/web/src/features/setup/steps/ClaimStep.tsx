import { useT } from '../../../infrastructure/i18n/locale';
// apps/web — ClaimStep.
//
// CAP-041 / step 1. The operator pastes the INSTALLATION_TOKEN. On success
// the wizard stores the returned session token in the in-memory Zustand
// store (R-SECRET-003) and advances to /setup/preflight.
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import type { SetupClaimRequest } from '@unimailbox/contracts';
import { setupClaimRequestSchema } from '@unimailbox/contracts';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setSetupSession } from '../setup-session-store';
import { SetupGuidance } from '../setup-guidance';

interface ClaimFormFields {
  readonly token: string;
}

export function ClaimStep(): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
  } | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ClaimFormFields>({
    resolver: zodResolver(setupClaimRequestSchema),
    defaultValues: { token: '' },
  });

  const watchedToken = watch('token');

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const response = await apiClient.fetch<{ data: { sessionToken: string } }>(
        '/api/v1/setup/claim',
        { method: 'POST', body: { token: values.token } satisfies SetupClaimRequest },
      );
      setSetupSession(response.data.sessionToken);
      await navigate({ to: '/setup/preflight' });
    } catch (error) {
      if (error instanceof ApiError) {
        setSubmitError({ message: error.message, code: error.code });
      } else {
        setSubmitError({
          message: 'Unexpected error',
          code: 'UNEXPECTED_ERROR',
        });
      }
    }
  });

  const tokenError = errors.token?.message;

  return (
    <Card
      title={t('Claim installation')}
      description={t('Provide the deploy-time INSTALLATION_TOKEN.')}
    >
      <SetupGuidance
        purpose="Confirm that you have access to the deployment before changing installation settings."
        prepare="The INSTALLATION_TOKEN supplied through your protected deployment handoff or secret manager."
        steps={[
          'Retrieve the token from the secure deployment owner or secret-management process.',
          'Paste it below and select Claim installation.',
        ]}
        success="A temporary setup session is created and the wizard moves to the preflight checks."
        note="The token is never written to browser storage. If you do not have it, contact the deployment owner; it cannot be recovered from this page."
      />
      <form onSubmit={onSubmit} noValidate>
        <Input
          id="claim-token"
          type="password"
          autoComplete="off"
          label={t('Installation token')}
          help={t('Required. Use the token from the protected deployment handoff.')}
          error={tokenError}
          {...register('token')}
        />
        {submitError !== null ? (
          <ErrorPanel
            message={submitError.message}
            code={submitError.code}
            onRetry={() => void onSubmit()}
          />
        ) : null}
        <div className="wizard-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting || watchedToken.length === 0}
            aria-busy={isSubmitting}
            data-testid="claim-submit"
          >
            {isSubmitting ? <Spinner /> : t('Claim installation')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
