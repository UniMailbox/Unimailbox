// apps/web — Unauthorized.
//
// CAP-042 (Batch 5) AC 20. The shared 401 / expired-session view. Used
// by the mailbox shell when its data fetch returns no session — the
// router's `beforeLoad` redirects to /login instead, so this component
// is the deeper fallback for components that render past the guard
// (e.g. a fetched page whose session expired mid-flight).
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';

export interface UnauthorizedProps {
  readonly variant?: 'unauthorized' | 'expired';
}

export function Unauthorized({
  variant = 'unauthorized',
}: UnauthorizedProps): ReactElement {
  const isExpired = variant === 'expired';
  return (
    <main className="auth-page" data-testid={isExpired ? 'expired-session' : 'unauthorized-page'}>
      <Card
        title={isExpired ? 'Session expired' : 'Sign in required'}
        description={
          isExpired
            ? 'Your session ended. Sign in again to continue.'
            : 'Sign in to access the mailbox.'
        }
      >
        <p data-testid="unauthorized-message">
          {isExpired
            ? 'For your security, sessions end after a period of inactivity.'
            : 'You need to be signed in to view this page.'}
        </p>
        <div className="wizard-actions">
          <Link to="/login" data-testid="unauthorized-login-link">
            <Button variant="primary" data-testid="unauthorized-login-button">
              Sign in
            </Button>
          </Link>
        </div>
      </Card>
    </main>
  );
}