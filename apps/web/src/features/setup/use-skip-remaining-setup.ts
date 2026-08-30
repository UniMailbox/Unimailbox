// apps/web — useSkipRemainingSetup hook.
//
// CAP-063: shared hook for the wizard's "Skip remaining setup" affordance.
// The hook owns the network call shape, error state, and post-success
// navigation; the visual is owned by <SkipRemainingSetupButton>. Six
// step components call this hook and render the button — the duplicated
// 30-line block from CAP-063 Option A lives here instead, in one place.
//
// R-WORKFLOW-002: reuses the existing /complete endpoint so the state flip
// stays a single D1 batch with its `setup.complete` audit row; this is
// not a second way to mark an installation complete.
//
// ADR-004: Idempotency-Key is added by the API client for every non-safe
// request — this hook never touches the header. Tests assert presence on
// the wire, not that the hook set it.
//
// HIGH 2 (CAP-041 fix): on 401 the session token is gone. The hook exposes
// `reclaim` so the caller can render an ErrorPanel whose retry label is
// "Re-claim installation token" and whose onRetry routes the operator back
// to /setup/claim — the same affordance CompleteStep uses.
import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { setupQueryKeys } from './setup-queries';
import { clearSetupSession } from './setup-session-store';

export interface SkipRemainingSetupError {
  readonly message: string;
  readonly code: string;
  readonly status: number | null;
}

export interface UseSkipRemainingSetup {
  /** Trigger the skip; safe to call repeatedly — overlapping clicks are no-ops while submitting. */
  readonly skip: () => Promise<void>;
  /** True from the moment `skip()` is called until its promise settles. */
  readonly submitting: boolean;
  /** Latest non-2xx result, cleared at the start of the next call. */
  readonly error: SkipRemainingSetupError | null;
  /** `true` iff the latest error was a 401 — the caller should render a "Re-claim" retry. */
  readonly isUnauthorized: boolean;
  /** Resets error state without firing a request — useful for UI dismissal. */
  readonly clearError: () => void;
}

export function useSkipRemainingSetup(): UseSkipRemainingSetup {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<SkipRemainingSetupError | null>(null);

  const skip = useCallback(async (): Promise<void> => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiClient.fetch('/api/v1/setup/complete', {
        method: 'POST',
        body: {},
      });
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/' });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError({
          message: caught.message,
          code: caught.code,
          status: caught.status,
        });
      } else {
        setError({
          message: 'Unexpected error',
          code: 'UNEXPECTED_ERROR',
          status: null,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [apiClient, navigate, queryClient, submitting]);

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  return {
    skip,
    submitting,
    error,
    isUnauthorized: error?.status === 401,
    clearError,
  };
}

/**
 * Imperative reclaim helper exposed for step components that need to wire
 * the 401 retry label without going through the hook itself.
 * Callers should bind this to the ErrorPanel's `onRetry` when
 * `isUnauthorized` is true.
 */
export function reclaimInstallationToken(navigate: ReturnType<typeof useNavigate>): void {
  clearSetupSession();
  void navigate({ to: '/setup/claim' });
}