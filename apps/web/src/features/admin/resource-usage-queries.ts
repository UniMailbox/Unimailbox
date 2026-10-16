import { useQuery } from '@tanstack/react-query';
import { resourceUsageResponseSchema } from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { authSessionQuery } from '../auth/auth-queries';

export function resourceUsageQuery(days: 7 | 30) {
  const client = useApiClient();
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: ['admin', 'resource-usage', session?.userId ?? 'anonymous', days],
    queryFn: async ({ signal }) => {
      const response = await client.fetch<{ data: unknown }>(
        `/api/v1/admin/resource-usage?days=${days}`,
        { signal, retry: false },
      );
      const parsed = resourceUsageResponseSchema.safeParse(response.data);
      if (!parsed.success)
        throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
      return parsed.data;
    },
    enabled: session !== undefined && session !== null,
    staleTime: 300_000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
