import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adminUserMailboxListResponseSchema,
  adminUserMailboxAccessResponseSchema,
  type AdminUserMailboxAccessRequest,
  type AdminUserMailboxItem,
} from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { authSessionQuery } from '../auth/auth-queries';

export const userMailboxAccessKey = (actorId: string, userId: string | null) =>
  ['admin', actorId, 'user-mailboxes', userId] as const;

export function useUserMailboxAccess(userId: string | null = null) {
  const apiClient = useApiClient();
  const actorId = authSessionQuery().data?.userId;
  return useQuery({
    queryKey: userMailboxAccessKey(actorId ?? 'anonymous', userId),
    enabled: actorId !== undefined,
    retry: false,
    queryFn: async () => {
      const response = await apiClient.fetch<{ data: unknown }>(
        userId === null
          ? '/api/v1/admin/mailboxes'
          : `/api/v1/admin/users/${encodeURIComponent(userId)}/mailboxes`,
      );
      const parsed = adminUserMailboxListResponseSchema.safeParse(response.data);
      if (!parsed.success)
        throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
      return parsed.data.items;
    },
  });
}

export function useSetUserMailboxAccess(userId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const actorId = authSessionQuery().data?.userId ?? 'anonymous';
  return useMutation({
    mutationFn: async (input: {
      mailboxId: string;
      role: AdminUserMailboxAccessRequest['role'];
    }) => {
      const response = await apiClient.fetch<unknown>(
        `/api/v1/admin/users/${encodeURIComponent(userId)}/mailboxes/${encodeURIComponent(input.mailboxId)}`,
        {
          method: 'PUT',
          body: { role: input.role },
        },
      );
      const parsed = adminUserMailboxAccessResponseSchema.safeParse(response);
      if (!parsed.success)
        throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
      return parsed.data.data;
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData<AdminUserMailboxItem[]>(
        userMailboxAccessKey(actorId, userId),
        (current) =>
          current?.map((mailbox) =>
            mailbox.id === saved.mailboxId ? { ...mailbox, role: saved.role } : mailbox,
          ),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: userMailboxAccessKey(actorId, userId) }),
        queryClient.invalidateQueries({ queryKey: ['mailbox', userId] }),
      ]);
    },
  });
}
