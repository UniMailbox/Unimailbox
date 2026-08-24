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
// CAP-043 Slice 3 adds the inbox-row actions:
//   - `useToggleMessageStarMutation` — `PATCH .../messages/:messageId/star`
//     (AC 13/14, D-CAP-043-A) with an optimistic flip on the inbox cache
//     and rollback on failure.
//   - `useDeleteMessageMutation` — `DELETE .../messages/:messageId`
//     (AC 15/16, D-CAP-043-B/E); the 204 response removes the row from
//     the inbox cache via structural `setQueryData`.
//
// CAP-044 Slice 1 adds the compose path:
//   - `useComposeMessageMutation` — `POST .../messages/send` (CAP-023
//     route) parsed with the contracts `composeResponseSchema`; success
//     invalidates the mailbox's messages family, failure surfaces to the
//     caller (the form keeps its values, AC 4).
//
// The hooks are keyed on `['mailbox', 'messages', mailboxId]` so a
// navigation to a different mailbox invalidates by query key (D-CAP-041-1
// cache pattern). The cursor is opaque to the client; we never inspect it.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  composeResponseSchema,
  mailboxListResponseSchema,
  messageDetailSchema,
  messageListResponseSchema,
  messageThreadResponseSchema,
  toggleStarResponseSchema,
  type MailboxListItem,
  type MessageDetail,
  type MessageListResponse,
  type MessageThreadResponse,
} from '@unimailbox/contracts';
import type { ApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';

// CAP-043 Slice 3 / gate 2: the mailbox-list wire shape was promoted
// verbatim into `packages/contracts` (`mailboxListResponseSchema` +
// `MailboxListItem`); the local zod copy that used to live here is
// deleted. The type is re-exported so `./mailbox-queries` stays the
// single import site for existing consumers (MailboxListPage) without
// forking the definition — one fact, one home.
export type { MailboxListItem };

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
      ? `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages`
      : `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages?cursor=${encodeURIComponent(cursor)}`;
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
  }>(
    // Fix pass (f): path ids are encoded — an id carrying reserved URL
    // characters must never alter the request path.
    `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
  );
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
  }>(
    `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}/thread`,
  );
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
        `/api/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/messages/${encodeURIComponent(input.messageId)}/read`,
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

export interface ToggleMessageStarInput {
  readonly mailboxId: string;
  readonly messageId: string;
}

/**
 * Star toggle mutation (CAP-043 Slice 3 / AC 13 + AC 14, D-CAP-043-A).
 *
 * AC 16: the flip is OPTIMISTIC — `onMutate` inverts the row's
 * `isStarred` in the inbox cache before the request flies, so the star
 * responds instantly. `onSuccess` then overwrites the guess with the
 * server's authoritative post-toggle value (mailbox-level star — another
 * member may have toggled concurrently, so the response is the only
 * truth).
 *
 * Slice 3 fix H7: `onError` rolls back with a ROW-SCOPED inverse flip —
 * a functional `setQueryData` that inverts `isStarred` on THIS message's
 * row only. The previous whole-snapshot restore could resurrect another
 * row's state: when two stars fail and the FIRST error's restore runs
 * before the SECOND's, the second snapshot (taken after A's optimistic
 * flip) overwrote A's rollback — leaving A starred with no server
 * confirmation. The inverse flip also no-ops when the row is gone (a
 * delete landed in between), unlike a snapshot restore, which would
 * resurrect a deleted row. A failed star warns once (G9 pattern):
 * ignorable for rendering, never silent.
 *
 * D-CAP-041-2: ApiClient mints the fresh Idempotency-Key per request;
 * the component never touches that header.
 */
export function useToggleMessageStarMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ToggleMessageStarInput): Promise<number> => {
      const response = await apiClient.fetch<unknown>(
        `/api/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/messages/${encodeURIComponent(input.messageId)}/star`,
        { method: 'PATCH' },
      );
      // Envelope-wrapped contract: { data: { id, isStarred } } — the
      // schema models the full wire body, so parse the whole response.
      const parsed = toggleStarResponseSchema.parse(response);
      return parsed.data.isStarred;
    },
    onMutate: async (input): Promise<void> => {
      // Stop in-flight refetches from clobbering the optimistic write.
      await queryClient.cancelQueries({
        queryKey: mailboxQueryKeys.messages(input.mailboxId),
      });
      // Structural additive copy — only this message's row changes.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId),
        (existing) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                pages: existing.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === input.messageId
                      ? { ...item, isStarred: item.isStarred === 1 ? 0 : 1 }
                      : item,
                  ),
                })),
              },
      );
    },
    onSuccess: (isStarred, input) => {
      // Server truth replaces the optimistic guess.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId),
        (existing) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                pages: existing.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === input.messageId ? { ...item, isStarred } : item,
                  ),
                })),
              },
      );
    },
    onError: (error, input) => {
      // H7: row-scoped inverse flip — undo THIS row's optimistic change
      // only. No snapshot, so a sibling mutation's state (another row's
      // star, or a delete that removed this row) is never clobbered; the
      // functional update no-ops when the row is no longer in the cache.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId),
        (existing) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                pages: existing.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === input.messageId
                      ? { ...item, isStarred: item.isStarred === 1 ? 0 : 1 }
                      : item,
                  ),
                })),
              },
      );
      const code = error instanceof ApiError ? error.code : 'UNKNOWN';
      console.warn('toggle-message-star failed', {
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        code,
        message: error.message,
      });
    },
  });
}

export interface DeleteMessageInput {
  readonly mailboxId: string;
  readonly messageId: string;
}

/**
 * Per-user soft-delete mutation (CAP-043 Slice 3 / AC 15 + AC 16,
 * D-CAP-043-B). The confirm dialog fires this once per confirmed click;
 * D-CAP-041-2 gives it a fresh Idempotency-Key, and a replayed key would
 * return the same 204 (R-API-004).
 *
 * D-CAP-043-E: the endpoint answers 204 No Content — ApiClient surfaces
 * that as `undefined`; there is no response body to parse.
 *
 * On success the row leaves the inbox cache via structural
 * `setQueryData` (filter, no refetch — D-CAP-041-1), and the message's
 * detail + thread cache entries are dropped so a later visit cannot
 * render a deleted message from cache (the API 404s it). On failure the
 * row stays and the mutation warns once (G9 pattern) — a failed delete
 * is ignorable for rendering, but never silent.
 *
 * Slice 3 fix H11: `onMutate` awaits `cancelQueries` on the inbox key
 * before the request flies — without it, an in-flight list refetch that
 * resolves after the success filter would resurrect the deleted row.
 */
export function useDeleteMessageMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteMessageInput): Promise<void> => {
      await apiClient.fetch(
        `/api/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/messages/${encodeURIComponent(input.messageId)}`,
        { method: 'DELETE' },
      );
    },
    onMutate: async (input): Promise<void> => {
      // H11: stop in-flight refetches of the inbox key so the success
      // filter is the last write.
      await queryClient.cancelQueries({
        queryKey: mailboxQueryKeys.messages(input.mailboxId),
      });
    },
    onSuccess: (_result, input) => {
      // Structural removal: pages/items copies with this message
      // filtered out; an absent cache stays absent.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId),
        (existing) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                pages: existing.pages.map((page) => ({
                  ...page,
                  items: page.items.filter((item) => item.id !== input.messageId),
                })),
              },
      );
      // Soft-deleted-for-this-user messages 404 at the detail and thread
      // routes; cached entries for them must not render again.
      queryClient.removeQueries({
        queryKey: mailboxQueryKeys.message(input.mailboxId, input.messageId),
      });
      queryClient.removeQueries({
        queryKey: mailboxQueryKeys.thread(input.mailboxId, input.messageId),
      });
    },
    onError: (error, input) => {
      const code = error instanceof ApiError ? error.code : 'UNKNOWN';
      console.warn('delete-message failed', {
        mailboxId: input.mailboxId,
        messageId: input.messageId,
        code,
        message: error.message,
      });
    },
  });
}

export interface ComposeMessageInput {
  readonly mailboxId: string;
  /** Already-normalised (trimmed, lower-cased) recipient addresses. */
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly textBody: string;
  /** Always '' in Phase 2 — the composer is plain-text only (D-CAP-044-B). */
  readonly htmlBody: string;
  /** RFC 5322 threading headers; present only on a reply (D-CAP-044-C). */
  readonly inReplyTo?: string;
  readonly references?: string;
}

/**
 * Compose/send mutation (CAP-044 Slice 1 / AC 3 + AC 4).
 *
 * POST /api/v1/mailboxes/:mailboxId/messages/send. The 202 body is
 * parsed with the contracts `composeResponseSchema`; the returned
 * messageId is the caller's success-confirmation surface (the message
 * itself is still `queued` — the durable outbox delivers it,
 * R-OUTBOUND-006).
 *
 * R-OUTBOUND-005 / D-CAP-041-2: ApiClient mints a fresh Idempotency-Key
 * for every fetch call, so one user click → one `mutate` call → one key.
 * A manual retry after failure is a NEW `mutate` call with a NEW key —
 * mutations do not auto-retry (App.tsx sets `mutations.retry: false`;
 * the ApiClient's 5xx backoff happens within a single call only).
 *
 * On success the `['mailbox','messages',mailboxId]` family is
 * invalidated: the sent copy appears in the mailbox's 'sent' folder and
 * the next inbox render refetches. On failure nothing is cached or
 * reset — the caller keeps the form's values and surfaces the error
 * inline (AC 4); the error is user-visible, so unlike the row actions
 * above there is no `console.warn` (nothing is swallowed).
 */
export function useComposeMessageMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ComposeMessageInput): Promise<string> => {
      const response = await apiClient.fetch<unknown>(
        `/api/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/messages/send`,
        {
          method: 'POST',
          // Threading headers are sent only when a reply carries them;
          // a fresh compose omits both keys entirely.
          body: {
            to: input.to.map((address) => ({ address })),
            cc: input.cc.map((address) => ({ address })),
            subject: input.subject,
            htmlBody: input.htmlBody,
            textBody: input.textBody,
            ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
            ...(input.references !== undefined ? { references: input.references } : {}),
          },
        },
      );
      // Fix pass (f): a 2xx body that does not match
      // composeResponseSchema surfaces as the same INVALID_RESPONSE code
      // the ApiClient uses for malformed bodies (status 0 — there is no
      // HTTP status to attribute to a client-side shape mismatch), never
      // as a raw ZodError.
      let messageId: string;
      try {
        messageId = composeResponseSchema.parse(response).data.messageId;
      } catch {
        throw new ApiError(
          'INVALID_RESPONSE',
          'Unexpected response from the server.',
          0,
        );
      }
      return messageId;
    },
    onSuccess: (_messageId, input) => {
      void queryClient.invalidateQueries({
        queryKey: mailboxQueryKeys.messages(input.mailboxId),
      });
    },
  });
}
