import { useT } from '../../../infrastructure/i18n/locale';
// apps/web — DomainStep.
//
// CAP-041 / step 4. Collects the managed domain. R-DATA-001: the wizard
// displays the normalized (lowercased) domain from the parsed form
// value rather than the user-typed form.
//
// H2 (CAP-041 fix): the unused `normalized` state and its setter are
// removed — the parsed form value is the single source of truth.
//
// CAP-063: skip button rendered via <SkipRemainingSetupButton /> below
// the form. R-WORKFLOW-002 reuses the existing /complete endpoint.
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import {
  domainNameSchema,
  setupDomainRequestSchema,
  type SetupDomainRequest,
} from '@unimailbox/contracts';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { useQueryClient } from '@tanstack/react-query';
import { setupQueryKeys } from '../setup-queries';
import { reclaimInstallationToken, useSkipRemainingSetup } from '../use-skip-remaining-setup';
import { SkipRemainingSetupButton } from '../SkipRemainingSetupButton';
import { SetupGuidance } from '../setup-guidance';

export function DomainStep(): ReactElement {
  const t = useT();
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
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SetupDomainRequest>({
    resolver: zodResolver(setupDomainRequestSchema),
    defaultValues: { name: '' },
  });

  const watchedName = watch('name');

  // HIGH 2 (CAP-041 fix): when the session token expires mid-wizard
  // (e.g. server rotates the session), the next mutation returns 401.
  // Surface that as a clear action: re-claim the installation token.
  const handleReclaim = (): void => {
    reclaimInstallationToken(navigate);
  };

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await apiClient.fetch('/api/v1/setup/domain', {
        method: 'POST',
        body: values,
      });
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/setup/cloudflare-verify' });
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

  const previewed =
    typeof watchedName !== 'string' || watchedName.length === 0
      ? null
      : (() => {
          const parsed = domainNameSchema.safeParse(watchedName);
          return parsed.success ? parsed.data : null;
        })();

  const submitErrorMessage = submitError?.message ?? '';
  const submitErrorCode = submitError?.code ?? '';
  const submitErrorStatus = submitError?.status ?? null;
  const isUnauthorized = submitErrorStatus === 401;

  return (
    <Card
      title={t('Add managed domain')}
      description={t('The domain that will receive mail for this deployment.')}
    >
      <SetupGuidance
        purpose="Tell Unimailbox which domain should receive inbound mail."
        prepare="A domain you control and can configure through Cloudflare Email Routing."
        steps={[
          'Enter the domain, including its suffix, such as mail.example.com.',
          'Review the normalized lowercase preview.',
          'Select Add domain to save the managed domain.',
        ]}
        success="The domain is saved as active and the wizard opens the Cloudflare Email Routing step."
        note="The name is trimmed and lowercased; duplicate managed domains cannot be added."
      />
      <form onSubmit={onSubmit} noValidate>
        <Input
          id="domain-name"
          type="text"
          autoComplete="off"
          label={t('Domain')}
          help={t('e.g. mail.example.com')}
          error={errors.name?.message}
          {...register('name')}
        />
        {previewed !== null ? (
          <p data-testid="domain-normalized" className="wizard-subtitle">
            {t('Will be stored as: ')}
            <code>{previewed}</code>
          </p>
        ) : null}
        {submitError !== null ? (
          <ErrorPanel
            message={submitErrorMessage}
            code={submitErrorCode}
            retryLabel={isUnauthorized ? t('Re-claim installation token') : t('Retry')}
            onRetry={isUnauthorized ? handleReclaim : () => void onSubmit()}
          />
        ) : null}
        <div className="wizard-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
            data-testid="domain-submit"
          >
            {isSubmitting ? <Spinner /> : t('Add domain')}
          </Button>
        </div>
      </form>
      {skipRemaining.error !== null ? (
        <ErrorPanel
          message={skipRemaining.error.message}
          code={skipRemaining.error.code}
          retryLabel={skipRemaining.isUnauthorized ? t('Re-claim installation token') : t('Retry')}
          onRetry={skipRemaining.isUnauthorized ? handleReclaim : () => void skipRemaining.skip()}
        />
      ) : null}
      <SkipRemainingSetupButton
        onSkip={() => void skipRemaining.skip()}
        submitting={skipRemaining.submitting}
      />
    </Card>
  );
}
