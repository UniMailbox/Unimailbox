// apps/web — AdministratorStep.
//
// CAP-041 / step 3. Creates the initial administrator. R-AUTH-002: the
// user is created with status='active' and the `administrator` role.
// The form uses the contracts zod schema directly via zodResolver — the
// UI does not invent a second contract model.
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import {
  setupAdministratorRequestSchema,
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
import { clearSetupSession } from '../setup-session-store';
import { useQueryClient } from '@tanstack/react-query';

export function AdministratorStep(): ReactElement {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);

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
    clearSetupSession();
    void navigate({ to: '/setup/claim' });
  };

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await apiClient.fetch('/api/v1/setup/administrator', {
        method: 'POST',
        body: values,
      });
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
      title="Create administrator"
      description="The first user becomes the initial administrator."
    >
      <form onSubmit={onSubmit} noValidate>
        <Input
          id="admin-email"
          type="email"
          autoComplete="username"
          label="Email"
          error={errors.email?.message}
          {...register('email')}
        />
        <Input
          id="admin-password"
          type="password"
          autoComplete="new-password"
          label="Password"
          help="Minimum 8 characters."
          error={errors.password?.message}
          {...register('password')}
        />
        <Input
          id="admin-display-name"
          type="text"
          autoComplete="name"
          label="Display name (optional)"
          error={errors.displayName?.message}
          {...register('displayName')}
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
            data-testid="administrator-submit"
          >
            {isSubmitting ? <Spinner /> : 'Create administrator'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
