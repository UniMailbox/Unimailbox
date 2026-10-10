import { useT } from '../../infrastructure/i18n/locale';
import { AuthLayout } from '../../components/layouts/AuthLayout';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { ApiError } from '../../infrastructure/api/errors';
import { useChangePasswordMutation } from './auth-queries';

const schema = z
  .object({
    currentPassword: z.string().min(1, 'FIELD_REQUIRED'),
    newPassword: z.string().min(6, 'PASSWORD_LENGTH').max(30, 'PASSWORD_LENGTH'),
    confirmPassword: z.string().min(6, 'PASSWORD_LENGTH').max(30, 'PASSWORD_LENGTH'),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    path: ['confirmPassword'],
    message: 'PASSWORD_MISMATCH',
  });

type FormValues = z.infer<typeof schema>;

export function ChangePasswordForm({
  onSuccess,
}: {
  onSuccess: () => void | Promise<void>;
}): ReactElement {
  const t = useT();
  const mutation = useChangePasswordMutation();
  const [error, setError] = useState<ApiError | null>(null);
  const { register, handleSubmit, formState, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const submit = handleSubmit(async (values) => {
    setError(null);
    try {
      await mutation.mutateAsync({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      reset();
      await onSuccess();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError('INTERNAL', 'Unable to change password', 500),
      );
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <Input
        id="current-password"
        type="password"
        autoComplete="current-password"
        label={t('Current password')}
        {...register('currentPassword')}
        error={formState.errors.currentPassword?.message}
      />
      <Input
        id="new-password"
        type="password"
        autoComplete="new-password"
        label={t('New password')}
        {...register('newPassword')}
        error={formState.errors.newPassword?.message}
      />
      <Input
        id="confirm-password"
        type="password"
        autoComplete="new-password"
        label={t('Confirm password')}
        {...register('confirmPassword')}
        error={formState.errors.confirmPassword?.message}
      />
      {error ? (
        <ErrorPanel message={error.message} code={error.code} testId="change-password-error" />
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={mutation.isPending}
        loading={mutation.isPending}
      >
        {t('Change password')}
      </Button>
    </form>
  );
}

export function ChangePasswordPage(): ReactElement {
  const t = useT();
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <main className="auth-page" data-testid="change-password-page">
        <Card
          title={t('Change your password')}
          description={t('Set a new password before opening your mailbox.')}
        >
          <ChangePasswordForm
            onSuccess={async () => {
              await navigate({ to: '/mailbox' });
            }}
          />
        </Card>
      </main>
    </AuthLayout>
  );
}
