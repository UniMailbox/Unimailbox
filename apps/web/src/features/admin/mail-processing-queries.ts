import { useQuery } from '@tanstack/react-query';
import { mailProcessingResponseSchema } from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { authSessionQuery } from '../auth/auth-queries';

export function mailProcessingQuery(days: 7 | 30) {
  const client = useApiClient();
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: ['admin', 'mail-processing', session?.userId ?? 'anonymous', days],
    queryFn: async ({ signal }) => {
      const result = await client.fetch<{ data: unknown }>(
        `/api/v1/admin/mail-processing?days=${days}`,
        { signal, retry: false },
      );
      const parsed = mailProcessingResponseSchema.safeParse(result.data);
      if (!parsed.success)
        throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
      return parsed.data;
    },
    enabled: session !== undefined && session !== null,
    staleTime: 300000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
