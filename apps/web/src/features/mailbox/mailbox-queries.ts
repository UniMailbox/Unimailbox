// apps/web — mailbox TanStack Query hooks.
//
// CAP-043 Slice 1. Two read paths the inbox shell needs:
//   - `mailboxListQuery` — `GET /api/v1/mailboxes` returns the user's
//     owned mailboxes (CAP-020 contract).
//   - `mailboxMessagesQuery` — `GET /api/v1/mailboxes/:mailboxId/messages`
//     returns a cursor-paginated page. The slice uses a `useInfiniteQuery`
//     hook so the inbox list can scroll forward through HMAC-signed
//     cursors without re-implementing pagination state.
//
// The hook keyed on `['mailbox', mailboxId, 'messages']` so a navigation
// to a different mailbox invalidates by query key (D-CAP-041-1 cache
// pattern). The cursor is opaque to the client; we never inspect it.
import { useInfiniteQuery, useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  messageListResponseSchema,
  type MessageListResponse,
} from '@unimailbox/contracts';
import { z } from 'zod';
import type { ApiClient } from '../../infrastructure/api/client';
import type { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';

/**
 * Closed schema for the mailbox-list response. We re-declare it here
 * rather than reusing `createMailboxRequestSchema` because the
 * /mailboxes endpoint (CAP-020) is a presentational list — its fields
 * are address / displayName / status — not a create payload. Until the
 * contracts package exposes a canonical `mailboxListResponseSchema`,
 * this local zod schema is the single place the web parses the wire
 * shape and surfaces `MailboxListItem` to consumers.
 */
const mailboxListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      address: z.string(),
      displayName: z.string(),
      status: z.string(),
      domainId: z.string(),
      localPart: z.string(),
      ownerUserId: z.string(),
    }),
  ),
});

export type MailboxListItem = z.infer<
  typeof mailboxListResponseSchema
>['items'][number];

export const mailboxQueryKeys = {
  all: ['mailbox'] as const,
  list: () => [...mailboxQueryKeys.all, 'list'] as const,
  messages: (mailboxId: string) =>
    [...mailboxQueryKeys.all, 'messages', mailboxId] as const,
};

/**
 * Fetcher for `GET /api/v1/mailboxes`.
 */
export async function fetchMailboxList(
  apiClient: ApiClient,
): Promise<MailboxListItem[]> {
  const response = await apiClient.fetch<{
    readonly data: { readonly items: MailboxListItem[] };
  }>('/api/v1/mailboxes');
  return mailboxListResponseSchema.parse(response.data).items;
}

/**
 * Query hook for the mailbox list. The shell calls this from
 * `MailboxListPage`; the cache is keyed on `mailboxQueryKeys.list()`
 * so a `setQueryData` write (CAP-043 Slice 3 — star/delete) updates
 * the list view without a refetch.
 */
export function mailboxListQuery(): UseQueryResult<MailboxListItem[], ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: mailboxQueryKeys.list(),
    queryFn: () => fetchMailboxList(apiClient),
    staleTime: 0,
  });
}

/**
 * Fetcher for a single inbox page. Returns the typed
 * `MessageListResponse` parsed through the contracts schema.
 */
export async function fetchMailboxMessagesPage(
  apiClient: ApiClient,
  mailboxId: string,
  cursor?: string,
): Promise<MessageListResponse> {
  const path =
    cursor === undefined
      ? `/api/v1/mailboxes/${mailboxId}/messages`
      : `/api/v1/mailboxes/${mailboxId}/messages?cursor=${encodeURIComponent(cursor)}`;
  const response = await apiClient.fetch<{
    readonly data: MessageListResponse;
  }>(path);
  return messageListResponseSchema.parse(response.data);
}

/**
 * Infinite query for the inbox list. The query key is scoped by
 * `mailboxId` so navigating to a different mailbox starts a fresh chain;
 * the `getNextPageParam` reads the page's `nextCursor` (HMAC-signed
 * opaque token) and returns it as the next `cursor` query parameter.
 *
 * A 400 INVALID_CURSOR response (R-API-005) surfaces through the query's
 * `error` state like every other failure. The recovery lives in
 * `InboxListPage`: the error panel's Retry button calls `refetch()`,
 * which re-issues the first-page GET — the only valid recovery for a
 * broken cursor chain (`fetchNextPage()` would re-send the failed
 * cursor). There is no dedicated refetch constant.
 */
export function mailboxMessagesInfiniteQuery(mailboxId: string) {
  const apiClient = useApiClient();
  // Fix pass F8: no positional generics — the data shape, InfiniteData,
  // query key, and page-param all infer from the options object
  // (`initialPageParam` pins the page-param to `string | undefined`).
  // The error type cannot be inferred (`ApiClient.fetch` rejects with
  // `ApiError` at runtime, but `Promise<T>` carries no rejection type),
  // so consumers narrow with `instanceof ApiError` — see InboxListPage.
  return useInfiniteQuery({
    queryKey: mailboxQueryKeys.messages(mailboxId),
    queryFn: ({ pageParam }) =>
      fetchMailboxMessagesPage(apiClient, mailboxId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
  });
}