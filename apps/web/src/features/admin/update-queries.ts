import { useQuery } from '@tanstack/react-query';
import { updateCheckResponseSchema, type UpdateCheckResponse } from '@unimailbox/contracts';
import type { ApiClient } from '../../infrastructure/api/client';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { authSessionQuery } from '../auth/auth-queries';

export const updateQueryKey = (userId: string) => ['admin', 'updates', userId] as const;

export async function fetchUpdateCheck(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<UpdateCheckResponse> {
  const response = await client.fetch<{ data: unknown }>('/api/v1/admin/updates', {
    retry: false,
    ...(signal === undefined ? {} : { signal }),
  });
  const parsed = updateCheckResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'Invalid update response.', 0);
  return parsed.data;
}

export function useUpdateCheck() {
  const client = useApiClient();
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: updateQueryKey(session?.userId ?? 'anonymous'),
    queryFn: ({ signal }) => fetchUpdateCheck(client, signal),
    enabled: session !== undefined && session !== null,
    staleTime: 15 * 60_000,
    refetchInterval: 60 * 60_000,
    retry: false,
  });
}
