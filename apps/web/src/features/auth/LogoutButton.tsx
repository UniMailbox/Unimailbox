// apps/web — LogoutButton.
//
// CAP-042 (Batch 5) AC 20. Posts to /api/v1/auth/better/sign-out
// (Better Auth clears the HttpOnly session cookie via its own
// `Set-Cookie` response) and then redirects to /login. The in-memory
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
import { Spinner } from '../../components/ui/Spinner';
import { authQueryKeys, useSignOutMutation } from './auth-queries';
import { clearAuthSession } from './auth-session-store';

export function LogoutButton(): ReactElement {
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
      aria-busy={signOutMutation.isPending}
      data-testid="logout-button"
    >
      {signOutMutation.isPending ? <Spinner /> : 'Sign out'}
    </Button>
  );
}