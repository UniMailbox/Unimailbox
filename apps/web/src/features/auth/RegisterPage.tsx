// apps/web — RegisterPage.
//
// CAP-042 (Batch 5) AC 20. Self-service registration lives at the
// application endpoint /api/v1/auth/register (Better Auth's `sign-up/email`
// is disabled at the framework level — see `integrations/better-auth/factory.ts`).
// The operator's email-domain prefix is enforced server-side per R-AUTH-008
// (avail-domain-pattern policy); the client-side rule reuses the contracts
// `emailAddressSchema` and a permissive password bound so an explicit
// server-side error surfaces.
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
import { useRegisterMutation } from './auth-queries';

/**
 * Local form schema for the registration payload. The invite `code` is
 * 64 hex characters (32 bytes, SHA-256 hashed server-side per CAP-018).
 * `displayName` is optional; the wire payload omits it when empty so the
 * server's optional-field handling kicks in cleanly.
 */
const registerSchema = z.object({
  code: z.string().length(64, 'Invite code must be 64 hex characters'),
  email: emailAddressSchema,
  password: z.string().min(1).max(72),
  displayName: z.string().max(100).optional(),
});

type RegisterFormFields = z.infer<typeof registerSchema>;

export function RegisterPage(): ReactElement {
  const navigate = useNavigate();
  const registerMutation = useRegisterMutation();
  const [submitError, setSubmitError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormFields>({
    resolver: zodResolver(registerSchema),
    defaultValues: { code: '', email: '', password: '', displayName: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const payload: {
        code: string;
        email: string;
        password: string;
        displayName?: string;
      } = {
        code: values.code,
        email: values.email,
        password: values.password,
      };
      if (values.displayName !== undefined && values.displayName.length > 0) {
        payload.displayName = values.displayName;
      }
      await registerMutation.mutateAsync(payload);
      // After successful registration, the user is *not* automatically
      // signed in — registration is a separate surface from sign-in
      // (CAP-019 / R-AUTH-006). Send them to /login.
      await navigate({ to: '/login' });
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

  const submitting = isSubmitting || registerMutation.isPending;

  return (
    <main className="auth-page" data-testid="register-page">
      <Card
        title="Create an account"
        description="Use the invite code your administrator emailed you."
      >
        <form onSubmit={onSubmit} noValidate>
          <Input
            id="register-code"
            type="text"
            autoComplete="off"
            label="Invite code"
            help="The 64-character hex code from your invitation."
            error={errors.code?.message}
            {...register('code')}
          />
          <Input
            id="register-email"
            type="email"
            autoComplete="username"
            label="Email"
            error={errors.email?.message}
            {...register('email')}
          />
          <Input
            id="register-password"
            type="password"
            autoComplete="new-password"
            label="Password"
            help="Between 6 and 30 characters (server-side rule)."
            error={errors.password?.message}
            {...register('password')}
          />
          <Input
            id="register-display-name"
            type="text"
            autoComplete="name"
            label="Display name (optional)"
            error={errors.displayName?.message}
            {...register('displayName')}
          />
          {submitError !== null ? (
            <ErrorPanel
              message={submitError.message}
              code={submitError.code}
              onRetry={() => void onSubmit()}
              testId="register-error"
            />
          ) : null}
          <div className="wizard-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
              aria-busy={submitting}
              data-testid="register-submit"
            >
              {submitting ? <Spinner /> : 'Create account'}
            </Button>
            <Link to="/login" className="btn btn-ghost btn-md" data-testid="register-login-link">
              I already have an account
            </Link>
          </div>
        </form>
      </Card>
    </main>
  );
}
