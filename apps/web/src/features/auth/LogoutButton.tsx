import { useT } from '../../infrastructure/i18n/locale';
// apps/web — LogoutButton.
//
// Posts to /api/v1/auth/logout, revokes the D1 session, and then redirects to
// /login. The in-memory
// session descriptor is cleared as part of the mutation's `onSuccess`
// (see `useSignOutMutation` in `auth-queries.ts`).
//
// Sign-out failures still clear the local store and redirect — the
// user's intent is to leave; we don't want a transient 5xx to strand
// them on a half-authenticated page. The server-side cookie is what
// matters for security; the local descriptor is purely cosmetic.
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button } from '../../components/ui/Button';
import { authQueryKeys, useSignOutMutation } from './auth-queries';
import { clearAuthSession } from './auth-session-store';

export function LogoutButton(): ReactElement {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOutMutation = useSignOutMutation();

  const handleSignOut = async (): Promise<void> => {
    try {
      await signOutMutation.mutateAsync();
    } catch {
      // Intentionally swallowed: a transient sign-out failure must
      // not strand the user. The server-side cookie is the source of
      // truth; clearing the in-memory descriptor and removing the
      // cache entry ensures the next /mailbox navigation sees a
      // missing session and redirects.
    }
    clearAuthSession();
    queryClient.removeQueries({ queryKey: authQueryKeys.session() });
    await navigate({ to: '/login' });
  };

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => void handleSignOut()}
      disabled={signOutMutation.isPending}
      loading={signOutMutation.isPending}
      data-testid="logout-button"
    >
      {t('Sign out')}
    </Button>
  );
}
