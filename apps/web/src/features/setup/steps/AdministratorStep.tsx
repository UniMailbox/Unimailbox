import { useT } from '../../../infrastructure/i18n/locale';
// apps/web — AdministratorStep.
//
// CAP-041 / step 3. Creates the initial administrator. R-AUTH-002: the
// user is created with status='active' and the `administrator` role.
// The form uses the contracts zod schema directly via zodResolver — the
// UI does not invent a second contract model.
//
// CAP-063 / D-CAP-063-2: the "Skip remaining setup" button is disabled
// here until the administrator form submits successfully. Completing the
// installation with no administrator user (R-AUTH-005) leaves nobody able
// to sign in, and no UI page can recover from that.
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import {
  installationStepSchema,
  setupAdministratorRequestSchema,
  type InstallationStateInfo,
  type SetupAdministratorRequest,
} from '@unimailbox/contracts';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setupQueryKeys } from '../setup-queries';
import { reclaimInstallationToken, useSkipRemainingSetup } from '../use-skip-remaining-setup';
import { SkipRemainingSetupButton } from '../SkipRemainingSetupButton';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SetupGuidance } from '../setup-guidance';

// CAP-063 / D-CAP-063-2: the steps whose presence as `currentStep` proves
// the administrator was already created. Derived from the contracts enum
// rather than hand-listed so a new wizard step cannot silently fall out of
// the set. `administrator` itself is excluded — the server only advances
// past it once the user row is committed.
const STEPS_IMPLYING_ADMINISTRATOR_EXISTS: ReadonlySet<string> = new Set(
  installationStepSchema.options.slice(installationStepSchema.options.indexOf('administrator') + 1),
);

export function AdministratorStep(): ReactElement {
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
  // CAP-063 / D-CAP-063-2: gates the skip button. Local state alone is
  // not enough — a successful POST navigates to /setup/domain, unmounting
  // this component, so an operator who returns here would find the button
  // disabled again despite the admin existing. The router already primed
  // `setupQueryKeys.status()` in the cache (see `requireSetupStep`), so
  // reading it here adds no request; `enabled: false` keeps this component
  // from issuing its own fetch.
  const [adminCreated, setAdminCreated] = useState(false);
  const statusQuery = useQuery<InstallationStateInfo>({
    queryKey: setupQueryKeys.status(),
    enabled: false,
  });
  const serverSaysAdminExists =
    statusQuery.data !== undefined &&
    (statusQuery.data.status === 'complete' ||
      STEPS_IMPLYING_ADMINISTRATOR_EXISTS.has(statusQuery.data.currentStep));
  const canSkip = adminCreated || serverSaysAdminExists;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SetupAdministratorRequest>({
    resolver: zodResolver(setupAdministratorRequestSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  });

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    reclaimInstallationToken(navigate);
  };

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await apiClient.fetch('/api/v1/setup/administrator', {
        method: 'POST',
        body: values,
      });
      setAdminCreated(true);
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/setup/domain' });
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
      title={t('Create administrator')}
      description={t('The first user becomes the initial administrator.')}
    >
      <SetupGuidance
        purpose="Create the first active user who will administer this installation."
        prepare="A monitored email address and a password you can use to sign in after setup."
        steps={[
          'Enter the administrator email address.',
          'Choose a password between 6 and 30 characters, then add an optional display name.',
          'Select Create administrator once the details are correct.',
        ]}
        success="The user, sign-in credential, and setup progress are committed together before the wizard advances to Domain."
        note="Use an address that can receive the outbound smoke-test email later in the wizard."
      />
      <form onSubmit={onSubmit} noValidate>
        <Input
          id="admin-email"
          type="email"
          autoComplete="username"
          label={t('Email')}
          error={errors.email?.message}
          {...register('email')}
        />
        <Input
          id="admin-password"
          type="password"
          autoComplete="new-password"
          label={t('Password')}
          help={t('6–30 characters.')}
          error={errors.password?.message}
          {...register('password')}
        />
        <Input
          id="admin-display-name"
          type="text"
          autoComplete="name"
          label={t('Display name (optional)')}
          error={errors.displayName?.message}
          {...register('displayName')}
        />
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
            data-testid="administrator-submit"
          >
            {isSubmitting ? <Spinner /> : t('Create administrator')}
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
        disabled={!canSkip}
      />
    </Card>
  );
}
