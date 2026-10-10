import { useT } from '../../infrastructure/i18n/locale';
import { AuthLayout } from '../../components/layouts/AuthLayout';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Card } from '../../components/ui/Card';

/** Public registration is closed; administrators create accounts in /admin. */
export function RegisterPage(): ReactElement {
  const t = useT();
  return (
    <AuthLayout>
      <main className="auth-page" data-testid="register-page">
        <Card
          title={t('Account access')}
          description={t('Accounts are created and managed by an administrator.')}
        >
          <p data-testid="registration-disabled">
            {t('Ask an administrator to create your mailbox account.')}
          </p>
          <Link to="/login" className="btn btn-primary" data-testid="registration-login-link">
            {t('Back to sign in')}
          </Link>
        </Card>
      </main>
    </AuthLayout>
  );
}
