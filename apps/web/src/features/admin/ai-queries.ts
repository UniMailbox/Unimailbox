import { useQuery } from '@tanstack/react-query';
import {
  aiConfigurationResponseSchema,
  type AiConfigurationResponse,
  type UpdateAiConfiguration,
} from '@unimailbox/contracts';
import type { ApiClient } from '../../infrastructure/api/client';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { authSessionQuery } from '../auth/auth-queries';
import { ApiError } from '../../infrastructure/api/errors';

export const aiConfigurationKey = (userId: string): readonly string[] => ['admin', userId, 'ai'];
function parseResponse(value: unknown): AiConfigurationResponse {
  const parsed = aiConfigurationResponseSchema.safeParse(
    (value as { data?: unknown } | null)?.data,
  );
  if (!parsed.success)
    throw new ApiError('INVALID_RESPONSE', 'Invalid AI configuration response', 0);
  return parsed.data;
}
export function useAiConfiguration() {
  const client = useApiClient();
  const session = authSessionQuery().data;
  return useQuery({
    queryKey: aiConfigurationKey(session?.userId ?? 'anonymous'),
    enabled: !!session,
    queryFn: async () => parseResponse(await client.fetch('/api/v1/admin/ai')),
  });
}
export async function saveAiConfiguration(
  client: ApiClient,
  request: UpdateAiConfiguration,
  revision: number,
): Promise<AiConfigurationResponse> {
  return parseResponse(
    await client.fetch('/api/v1/admin/ai', {
      method: 'PUT',
      body: request,
      headers: { 'If-Match': String(revision) },
    }),
  );
}
