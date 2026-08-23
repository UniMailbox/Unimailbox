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
// CAP-043 Slice 2 adds the message-detail surface:
//   - `messageDetailQuery` / `messageThreadQuery` — the detail page's
//     two reads (`GET .../messages/:messageId` + `GET .../thread`),
//     keyed inside the existing `['mailbox', 'messages', mailboxId]`
//     family so they extend, not fork, the cache tree.
//   - `useMarkMessageReadMutation` — `PATCH .../messages/:messageId/read`
//     fired once per detail-page mount when the message is unread
//     (R-MESSAGE-005). D-CAP-041-2: ApiClient mints the fresh
//     Idempotency-Key; components never touch that header.
//
// The hook keyed on `['mailbox', mailboxId, 'messages']` so a navigation
// to a different mailbox invalidates by query key (D-CAP-041-1 cache
// pattern). The cursor is opaque to the client; we never inspect it.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  messageDetailSchema,
  messageListResponseSchema,
  messageThreadResponseSchema,
  type MessageDetail,
  type MessageListResponse,
  type MessageThreadResponse,
} from '@unimailbox/contracts';
import { z } from 'zod';
import type { ApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
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
  message: (mailboxId: string, messageId: string) =>
    [...mailboxQueryKeys.all, 'messages', mailboxId, 'detail', messageId] as const,
  thread: (mailboxId: string, messageId: string) =>
    [...mailboxQueryKeys.all, 'messages', mailboxId, 'thread', messageId] as const,
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

/**
 * Fetcher for `GET .../messages/:messageId` — the message detail. Parsed
 * through the contracts schema; the caller gets a typed `MessageDetail`
 * (CAP-043 Slice 2 / AC 11).
 */
export async function fetchMessageDetail(
  apiClient: ApiClient,
  mailboxId: string,
  messageId: string,
): Promise<MessageDetail> {
  const response = await apiClient.fetch<{
    readonly data: MessageDetail;
  }>(`/api/v1/mailboxes/${mailboxId}/messages/${messageId}`);
  return messageDetailSchema.parse(response.data);
}

/**
 * Query hook for the message detail. Keyed inside the
 * `['mailbox', 'messages', mailboxId]` family (extend, not fork) so the
 * detail cache lives beside the inbox pages it is opened from.
 */
export function messageDetailQuery(
  mailboxId: string,
  messageId: string,
): UseQueryResult<MessageDetail, ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: mailboxQueryKeys.message(mailboxId, messageId),
    queryFn: () => fetchMessageDetail(apiClient, mailboxId, messageId),
    staleTime: 0,
  });
}

/**
 * Fetcher for `GET .../messages/:messageId/thread` — the thread panel's
 * same-thread messages, oldest-first, per D-CAP-043-C / AC 10.
 */
export async function fetchMessageThread(
  apiClient: ApiClient,
  mailboxId: string,
  messageId: string,
): Promise<MessageThreadResponse> {
  const response = await apiClient.fetch<{
    readonly data: MessageThreadResponse;
  }>(`/api/v1/mailboxes/${mailboxId}/messages/${messageId}/thread`);
  return messageThreadResponseSchema.parse(response.data);
}

/**
 * Query hook for the thread. Same key family as the detail query; the
 * thread is keyed by the anchor message the user opened.
 */
export function messageThreadQuery(
  mailboxId: string,
  messageId: string,
): UseQueryResult<MessageThreadResponse, ApiError> {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: mailboxQueryKeys.thread(mailboxId, messageId),
    queryFn: () => fetchMessageThread(apiClient, mailboxId, messageId),
    staleTime: 0,
  });
}

export interface MarkMessageReadInput {
  readonly mailboxId: string;
  readonly messageId: string;
}

/**
 * Mark-read mutation (CAP-043 Slice 2 / AC 12, R-MESSAGE-005).
 *
 * The detail page fires this exactly once per mount when the message is
 * unread. D-CAP-041-2: ApiClient mints a fresh `Idempotency-Key` for
 * every non-GET request and components never touch that header — one
 * mutation invocation per mount therefore means one fresh key per
 * mount.
 *
 * On success BOTH caches flip via targeted `setQueryData` writes — only
 * the affected entries change; no refetch, no full invalidation
 * (D-CAP-041-1):
 *   - the INBOX list entry for this message turns read (the infinite
 *     query's page is copied structurally);
 *   - the DETAIL entry turns read too (Slice 2 fix G6, fe M1 / code M1).
 *     Without the detail flip the cached detail still said `isRead: 0`,
 *     so every reopen of an already-read message re-fired a redundant
 *     PATCH on mount.
 *
 * On failure the mutation warns once (Slice 2 fix G9, fe L1 / code L3):
 * a failed mark-read is genuinely ignorable — the page keeps rendering —
 * but not silent. Never swallow an error to keep a happy path green.
 */
export function useMarkMessageReadMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: MarkMessageReadInput): Promise<void> => {
      await apiClient.fetch(
        `/api/v1/mailboxes/${input.mailboxId}/messages/${input.messageId}/read`,
        { method: 'PATCH' },
      );
    },
    onSuccess: (_result, input) => {
      // R-MESSAGE-005: flip the inbox row for THIS message only. The
      // write is structurally additive (pages/items copies) so an
      // in-flight fetch of the same key is not torn.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId),
        (existing) => {
          if (existing === undefined) {
            return existing;
          }
          return {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.id === input.messageId ? { ...item, isRead: 1 } : item,
              ),
            })),
          };
        },
      );
      // G6: flip the detail cache with the same additive-copy strategy —
      // a cached entry that is absent stays absent (nothing to correct).
      queryClient.setQueryData<MessageDetail>(
        mailboxQueryKeys.message(input.mailboxId, input.messageId),
        (existing) =>
          existing === undefined ? existing : { ...existing, isRead: 1 },
      );
    },
    onError: (error, input) => {
      // G9: the code lives on ApiError at runtime (every ApiClient
      // rejection is one); anything else narrows to a generic code.
      const code = error instanceof ApiError ? error.code : 'UNKNOWN';
      console.warn('mark-message-read failed', {
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        code,
        message: error.message,
      });
    },
  });
}