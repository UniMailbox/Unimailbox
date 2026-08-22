// apps/web — setup TanStack Query hooks.
//
// CAP-041 wires the wizard's server state. The server is the source of truth
// for installation progress (R-WORKFLOW-001 / R-WORKFLOW-002); every mutation
// invalidates the status query so the router's `beforeLoad` re-evaluates and
// redirects to the new current step.
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  installationStateInfoSchema,
  setupPreflightResponseSchema,
  type InstallationStateInfo,
  type SetupPreflightResponse,
} from '@unimailbox/contracts';
import type { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';

export const setupQueryKeys = {
  all: ['setup'] as const,
  status: () => [...setupQueryKeys.all, 'status'] as const,
  preflight: () => [...setupQueryKeys.all, 'preflight'] as const,
};

/**
 * Fetcher for the setup status. Returns the parsed `InstallationStateInfo`.
 * Throws `ApiError` on any non-2xx response.
 */
export async function fetchSetupStatus(
  apiClient: ReturnType<typeof useApiClient>,
): Promise<InstallationStateInfo> {
  const response = await apiClient.fetch<{ data: InstallationStateInfo }>('/api/v1/setup/status');
  return installationStateInfoSchema.parse(response.data);
}

/**
 * Query hook for the setup status. Stale after 1s while the wizard is
 * mounting — the `beforeLoad` always re-runs, so the value is effectively
 * fresh on every nav.
 */
export function setupStatusQuery(): UseQueryResult<InstallationStateInfo, ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: setupQueryKeys.status(),
    queryFn: () => fetchSetupStatus(apiClient),
    staleTime: 0,
  });
}

/**
 * Fetcher for the preflight response. The Worker exposes binding presence
 * and the current schema version; the UI renders each binding as a row.
 */
export async function fetchSetupPreflight(
  apiClient: ReturnType<typeof useApiClient>,
): Promise<SetupPreflightResponse> {
  const response = await apiClient.fetch<{ data: SetupPreflightResponse }>(
    '/api/v1/setup/preflight',
    { method: 'POST', body: {} },
  );
  return setupPreflightResponseSchema.parse(response.data);
}

/**
 * Query hook for the preflight checks. The query is gated on the operator
 * having a session token (the /preflight route is session-protected).
 */
export function setupPreflightQuery(): UseQueryResult<SetupPreflightResponse, ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: setupQueryKeys.preflight(),
    queryFn: () => fetchSetupPreflight(apiClient),
    staleTime: 0,
  });
}
