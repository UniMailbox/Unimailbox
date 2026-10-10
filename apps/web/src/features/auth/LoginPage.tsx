import { useT } from '../../infrastructure/i18n/locale';
import { AuthLayout } from '../../components/layouts/AuthLayout';
// apps/web — LoginPage.
//
// Posts to the application-owned /api/v1/auth/login endpoint and keeps the
// short-lived access token in the in-memory auth store. Errors are surfaced as
// the existing ErrorPanel primitive
// (R-API-002 — machine code sub-line). The form is parsed by a local
// zod schema (loginSchema) that reuses the contracts `emailAddressSchema`
// — no second contract model for the input shape.
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { emailAddressSchema } from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { ApiError } from '../../infrastructure/api/errors';
import { useSignInMutation } from './auth-queries';

/**
 * Local form schema. R-AUTH-007's reconciled password bounds
 * (6..30 characters) are enforced server-side; the client-side rule
 * mirrors that bound so a too-short or too-long password is rejected
 * with a real validation error rather than round-tripping to the
 * server. The contracts `emailAddressSchema` is the canonical email
 * normaliser.
 */
const loginSchema = z.object({
  email: emailAddressSchema,
  password: z.string().min(6, 'PASSWORD_LENGTH').max(30, 'PASSWORD_LENGTH'),
});

type LoginFormFields = z.infer<typeof loginSchema>;

export function LoginPage(): ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const signInMutation = useSignInMutation();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormFields>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const descriptor = await signInMutation.mutateAsync({
        email: values.email,
        password: values.password,
      });
      await navigate({ to: descriptor.mustChangePassword ? '/change-password' : '/mailbox' });
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

  const submitting = isSubmitting || signInMutation.isPending;
  const isUnauthorized = submitError?.status === 401;

  return (
    <AuthLayout>
      <main className="auth-page" data-testid="login-page">
        <Card title={t('Sign in')}>
          <form onSubmit={onSubmit} noValidate>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              label={t('Email')}
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              label={t('Password')}
              error={errors.password?.message}
              {...register('password')}
            />
            {submitError !== null ? (
              <ErrorPanel
                message={submitError.message}
                code={submitError.code}
                retryLabel={isUnauthorized ? t('Try again') : t('Retry')}
                onRetry={() => void onSubmit()}
                testId={isUnauthorized ? 'login-unauthorized' : 'login-error'}
              />
            ) : null}
            <div className="wizard-actions">
              <Button
                type="submit"
                variant="primary"
                disabled={submitting}
                loading={submitting}
                data-testid="login-submit"
              >
                {t('Sign in')}
              </Button>
            </div>
          </form>
        </Card>
      </main>
    </AuthLayout>
  );
}
