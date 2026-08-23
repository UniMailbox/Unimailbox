// apps/web — LoginPage.
//
// CAP-042 (Batch 5) AC 20. Posts to /api/v1/auth/better/sign-in/email,
// receives Better Auth's HttpOnly session cookie, navigates to /mailbox
// on success. Errors are surfaced as the existing ErrorPanel primitive
// (R-API-002 — machine code sub-line). The form is parsed by a local
// zod schema (loginSchema) that reuses the contracts `emailAddressSchema`
// — no second contract model for the input shape.
import { Link, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { emailAddressSchema } from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { ApiError } from '../../infrastructure/api/errors';
import { useSignInMutation } from './auth-queries';
import { setAuthSession } from './auth-session-store';

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
  password: z.string().min(6).max(30),
});

type LoginFormFields = z.infer<typeof loginSchema>;

export function LoginPage(): ReactElement {
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
      setAuthSession(descriptor);
      await navigate({ to: '/mailbox' });
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
    <main className="auth-page" data-testid="login-page">
      <Card title="Sign in" description="Sign in with your email and password.">
        <form onSubmit={onSubmit} noValidate>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            label="Email"
            error={errors.email?.message}
            {...register('email')}
          />
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            label="Password"
            error={errors.password?.message}
            {...register('password')}
          />
          {submitError !== null ? (
            <ErrorPanel
              message={submitError.message}
              code={submitError.code}
              retryLabel={isUnauthorized ? 'Try again' : 'Retry'}
              onRetry={() => void onSubmit()}
              testId={isUnauthorized ? 'login-unauthorized' : 'login-error'}
            />
          ) : null}
          <div className="wizard-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
              aria-busy={submitting}
              data-testid="login-submit"
            >
              {submitting ? <Spinner /> : 'Sign in'}
            </Button>
            <Link
              to="/register"
              className="btn btn-ghost btn-md"
              data-testid="login-register-link"
            >
              Create an account
            </Link>
          </div>
        </form>
      </Card>
    </main>
  );
}