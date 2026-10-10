import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { scheduledSendListSchema, type ScheduledSendItem } from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { mailboxQueryKeys } from './mailbox-queries';
import { ScheduleSendDialog } from './ScheduleSendDialog';
import { useT } from '../../infrastructure/i18n/locale';
import { Button } from '../../components/ui/Button';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { InboxListSkeleton } from './InboxListSkeleton';
import { LocalDateTime } from '../../components/ui/LocalDateTime';

export function ScheduledSendsPage({ mailboxId }: { mailboxId: string }) {
  const t = useT();
  const api = useApiClient();
  const cache = useQueryClient();
  const session = authSessionQuery();
  const userId = session.data?.userId ?? null;
  const canSend = userId !== null;
  const [editing, setEditing] = useState<ScheduledSendItem | null>(null);
  const family = mailboxQueryKeys.messagesFamily(mailboxId, userId);
  const base = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/scheduled-sends`;
  const query = useInfiniteQuery({
    queryKey: [...family, 'scheduled-sends'],
    enabled: userId !== null,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const response = await api.fetch<{ data: unknown }>(
        `${base}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { method: 'GET' },
      );
      const parsed = scheduledSendListSchema.safeParse(response.data);
      if (!parsed.success) throw new ApiError('INVALID_RESPONSE', 'Unexpected server response.', 0);
      return parsed.data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const mutation = useMutation({
    mutationFn: ({ item, time }: { item: ScheduledSendItem; time?: string }) =>
      api.fetch(`${base}/${encodeURIComponent(item.id)}${time ? '' : '/cancel'}`, {
        method: time ? 'PATCH' : 'POST',
        body: { expectedRevision: item.revision, ...(time ? { scheduledAt: time } : {}) },
      }),
    onSuccess: async () => {
      setEditing(null);
      await cache.invalidateQueries({ queryKey: family });
    },
    onError: () => {
      setEditing(null);
      void cache.invalidateQueries({ queryKey: family });
    },
    retry: false,
  });
  const error = mutation.error ?? query.error;
  if (session.data === null) return <Unauthorized variant="expired" />;
  if (session.error && !session.data)
    return (
      <ErrorPanel
        message={session.error.message}
        code={session.error instanceof ApiError ? session.error.code : 'UNKNOWN'}
        onRetry={() => void session.refetch()}
      />
    );
  if (!query.data && !query.error) return <InboxListSkeleton />;
  return (
    <main className="mailbox-shell">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h1 className="text-xl font-semibold">{t('Scheduled')}</h1>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {t('Refresh')}
        </Button>
      </div>
      {error ? (
        <ErrorPanel
          message={error.message}
          code={error instanceof ApiError ? error.code : 'UNKNOWN'}
          onRetry={() => {
            mutation.reset();
            if (error instanceof ApiError && error.code === 'INVALID_CURSOR')
              void cache.resetQueries({ queryKey: [...family, 'scheduled-sends'] });
            else void query.refetch();
          }}
        />
      ) : null}
      {query.data?.pages.flatMap((page) => page.items).length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {t('No scheduled messages')}
        </p>
      ) : null}
      <ul className="divide-y rounded-md border">
        {query.data?.pages
          .flatMap((page) => page.items)
          .map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <Link
                  className="block font-medium truncate"
                  to="/mailbox/$mailboxId/messages/$messageId"
                  params={{ mailboxId, messageId: item.id }}
                >
                  {item.subject || t('(no subject)')}
                </Link>
                <p className="text-xs text-muted-foreground truncate">
                  {item.recipients.to.map((recipient) => recipient.address).join(', ')}
                </p>
                <LocalDateTime className="text-sm" value={item.scheduledAt} />
              </div>
              {canSend ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={mutation.isPending}
                    onClick={() => {
                      mutation.reset();
                      setEditing(item);
                    }}
                  >
                    {t('Change time')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={mutation.isPending}
                    onClick={() => mutation.mutate({ item })}
                  >
                    {t('Cancel send')}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t('Load more')}
        </Button>
      ) : null}
      {editing ? (
        <ScheduleSendDialog
          key={`${editing.id}:${editing.revision}`}
          open
          onClose={() => setEditing(null)}
          onConfirm={(time) => mutation.mutate({ item: editing, time })}
          initialTime={editing.scheduledAt}
          pending={mutation.isPending}
        />
      ) : null}
    </main>
  );
}
