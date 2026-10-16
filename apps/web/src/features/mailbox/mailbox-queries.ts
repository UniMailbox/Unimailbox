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
//     keyed inside the existing user-scoped mailbox messages family so they
//     extend, not fork, the cache tree.
//   - `useMarkMessageReadMutation` — `PATCH .../messages/:messageId/read`
//     fired once per detail-page mount when the message is unread
//     (R-MESSAGE-005). D-CAP-041-2: ApiClient mints the fresh
//     Idempotency-Key; components never touch that header.
//
// CAP-043 Slice 3 adds the mailbox-row actions (CAP-058 makes star state
// caller-scoped):
//   - `useToggleMessageStarMutation` — `PATCH .../messages/:messageId/star`
//     (AC 13/14) with an optimistic flip on the caller-scoped folder cache
//     and rollback on failure.
//   - `useDeleteMessageMutation` — `DELETE .../messages/:messageId`
//     (AC 15/16, D-CAP-043-B/E); the 204 response removes the row from
//     the active folder cache via structural `setQueryData`.
//
// CAP-044 Slice 1 adds the compose path:
//   - `useComposeMessageMutation` — `POST .../messages/send` (CAP-023
//     route) parsed with the contracts `composeResponseSchema`; success
//     invalidates the mailbox's messages family, failure surfaces to the
//     caller (the form keeps its values, AC 4).
//
// The hooks are keyed on `['mailbox', userId, 'messages', mailboxId, folder]`
// so navigation to a different folder, mailbox, or account isolates its
// cache (D-CAP-041-1 / CAP-058 / CAP-060). The cursor is opaque to the
// client; we never inspect it.
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  composeResponseSchema,
  messageFolderSchema,
  draftDetailResponseSchema,
  addMailboxMemberResponseSchema,
  deleteMailboxMemberResponseSchema,
  mailboxMemberListResponseSchema,
  mailboxListResponseSchema,
  messageDetailSchema,
  messageListResponseSchema,
  messageThreadResponseSchema,
  toggleStarResponseSchema,
  type MailboxListItem,
  type MailboxMemberItem,
  type AddMailboxMemberRequest,
  type MessageDetail,
  type MessageFolder,
  type MessageListResponse,
  type MessageThreadResponse,
  type DraftResponse,
  type UpdateDraftRequest,
} from '@unimailbox/contracts';
import type { ApiClient } from '../../infrastructure/api/client';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { authSessionQuery } from '../auth/auth-queries';

// A query may be created briefly while the auth descriptor is loading. Keep
// that cache namespace separate from every authenticated user; production
// hooks enable their fetch only once a real userId is available.
const ANONYMOUS_USER_KEY = '__anonymous__';

function defaultUserKey(): string {
  // Direct key-factory callers (including tests) can still seed the key that
  // the hooks use when the auth query is not mounted. Production hooks pass
  // the auth-query userId explicitly below.
  return ANONYMOUS_USER_KEY;
}

function scopedUserKey(userId: string | null | undefined): string {
  return userId === undefined ? defaultUserKey() : (userId ?? ANONYMOUS_USER_KEY);
}

function invertedStar(value: 0 | 1): 0 | 1 {
  return value === 1 ? 0 : 1;
}

// CAP-043 Slice 3 / gate 2: the mailbox-list wire shape was promoted
// verbatim into `packages/contracts` (`mailboxListResponseSchema` +
// `MailboxListItem`); the local zod copy that used to live here is
// deleted. The type is re-exported so `./mailbox-queries` stays the
// single import site for existing consumers (MailboxListPage) without
// forking the definition — one fact, one home.
export type { MailboxListItem };

// Bounded UI snapshots; server authorization is checked on every network request.
export const mailboxCachePolicy = {
  list: 60_000,
  messages: 10_000,
  detail: 30_000,
  thread: 10_000,
} as const;

export const mailboxQueryKeys = {
  all: (userId?: string | null) => ['mailbox', scopedUserKey(userId)] as const,
  list: (userId?: string | null) => [...mailboxQueryKeys.all(userId), 'list'] as const,
  messagesFamily: (mailboxId: string, userId?: string | null) =>
    [...mailboxQueryKeys.all(userId), 'messages', mailboxId] as const,
  messages: (mailboxId: string, userId?: string | null, folder: MessageFolder = 'inbox') =>
    [...mailboxQueryKeys.messagesFamily(mailboxId, userId), folder] as const,
  message: (mailboxId: string, messageId: string, userId?: string | null) =>
    [...mailboxQueryKeys.all(userId), 'messages', mailboxId, 'detail', messageId] as const,
  thread: (mailboxId: string, messageId: string, userId?: string | null) =>
    [...mailboxQueryKeys.all(userId), 'messages', mailboxId, 'thread', messageId] as const,
  draft: (mailboxId: string, draftId: string, userId?: string | null) =>
    [...mailboxQueryKeys.all(userId), 'drafts', mailboxId, draftId] as const,
  members: (mailboxId: string, userId?: string | null) =>
    [...mailboxQueryKeys.all(userId), 'members', mailboxId] as const,
};

/** Cancel both cached refetches and first reads before confirming local message state. */
function cancelMessageViewReads(client: QueryClient, userId: string | null, mailboxId: string) {
  const family = mailboxQueryKeys.messagesFamily(mailboxId, userId);
  return client.cancelQueries({
    queryKey: family,
    predicate: ({ queryKey }) =>
      (queryKey.length === family.length + 1 &&
        messageFolderSchema.safeParse(queryKey[family.length]).success) ||
      (queryKey.length === family.length + 2 &&
        (queryKey[family.length] === 'detail' || queryKey[family.length] === 'thread')),
  });
}

/** Keep every cached view of the same caller's message coherent after a confirmed write. */
function updateMessageViews(
  client: QueryClient,
  userId: string | null,
  mailboxId: string,
  messageId: string,
  patch: Pick<Partial<MessageDetail>, 'isRead' | 'isStarred'> | null,
): void {
  const family = mailboxQueryKeys.messagesFamily(mailboxId, userId);
  client.setQueriesData<InfiniteData<MessageListResponse>>(
    {
      queryKey: family,
      predicate: (query) =>
        query.queryKey.length === family.length + 1 &&
        messageFolderSchema.safeParse(query.queryKey[family.length]).success,
    },
    (existing) =>
      existing === undefined
        ? existing
        : {
            ...existing,
            pages: existing.pages.map((page) => ({
              ...page,
              items:
                patch === null
                  ? page.items.filter((item) => item.id !== messageId)
                  : page.items.map((item) =>
                      item.id === messageId ? { ...item, ...patch } : item,
                    ),
            })),
          },
  );
  client.setQueriesData<MessageThreadResponse>({ queryKey: [...family, 'thread'] }, (existing) =>
    existing === undefined
      ? existing
      : {
          ...existing,
          items:
            patch === null
              ? existing.items.filter((item) => item.id !== messageId)
              : existing.items.map((item) =>
                  item.id === messageId ? { ...item, ...patch } : item,
                ),
        },
  );
  if (patch !== null)
    client.setQueryData<MessageDetail>(
      mailboxQueryKeys.message(mailboxId, messageId, userId),
      (existing) => (existing === undefined ? existing : { ...existing, ...patch }),
    );
}

/**
 * Fetcher for `GET /api/v1/mailboxes`.
 */
export async function fetchMailboxList(apiClient: ApiClient): Promise<MailboxListItem[]> {
  const response = await apiClient.fetch<{
    readonly data: { readonly items: MailboxListItem[] };
  }>('/api/v1/mailboxes');
  return mailboxListResponseSchema.parse(response.data).items;
}

/**
 * Query hook for the mailbox list. The shell calls this from
 * `MailboxListPage`; the cache is keyed on the authenticated user's
 * mailboxQueryKeys.list(userId) namespace so a cache write cannot cross
 * account boundaries.
 */
export function mailboxListQuery(): UseQueryResult<MailboxListItem[], ApiError> {
  const apiClient = useApiClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useQuery({
    queryKey: mailboxQueryKeys.list(userId),
    queryFn: () => fetchMailboxList(apiClient),
    enabled: userId !== null,
    staleTime: mailboxCachePolicy.list,
  });
}

/**
 * Fetcher for a single mailbox-folder page. Returns the typed
 * `MessageListResponse` parsed through the contracts schema.
 */
export async function fetchMailboxMessagesPage(
  apiClient: ApiClient,
  mailboxId: string,
  cursor?: string,
  folder: MessageFolder = 'inbox',
): Promise<MessageListResponse> {
  const params = new URLSearchParams();
  // The API defaults to inbox. Omitting the default keeps existing callers'
  // request shape stable while every non-default view is explicit on the wire.
  if (folder !== 'inbox') {
    params.set('folder', folder);
  }
  if (cursor !== undefined) {
    params.set('cursor', cursor);
  }
  const query = params.toString();
  const path = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages${query ? `?${query}` : ''}`;
  const response = await apiClient.fetch<{
    readonly data: MessageListResponse;
  }>(path);
  return messageListResponseSchema.parse(response.data);
}

/**
 * Infinite query for one folder view. The query key is scoped by
 * `mailboxId` and `folder` so navigating to a different view starts a fresh chain;
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
export function mailboxMessagesInfiniteQuery(mailboxId: string, folder: MessageFolder = 'inbox') {
  const apiClient = useApiClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  // Fix pass F8: no positional generics — the data shape, InfiniteData,
  // query key, and page-param all infer from the options object
  // (`initialPageParam` pins the page-param to `string | undefined`).
  // The error type cannot be inferred (`ApiClient.fetch` rejects with
  // `ApiError` at runtime, but `Promise<T>` carries no rejection type),
  // so consumers narrow with `instanceof ApiError` — see InboxListPage.
  return useInfiniteQuery({
    queryKey: mailboxQueryKeys.messages(mailboxId, userId, folder),
    queryFn: ({ pageParam }) => fetchMailboxMessagesPage(apiClient, mailboxId, pageParam, folder),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: userId !== null,
    staleTime: mailboxCachePolicy.messages,
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
 * user-scoped `['mailbox', userId, 'messages', mailboxId]` family (extend,
 * not fork) so the detail cache lives beside every folder page it is opened
 * from without crossing account boundaries.
 */
export function messageDetailQuery(
  mailboxId: string,
  messageId: string,
): UseQueryResult<MessageDetail, ApiError> {
  const apiClient = useApiClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useQuery({
    queryKey: mailboxQueryKeys.message(mailboxId, messageId, userId),
    queryFn: () => fetchMessageDetail(apiClient, mailboxId, messageId),
    enabled: userId !== null,
    staleTime: mailboxCachePolicy.detail,
  });
}

/**
 * Fetcher for the server-authoritative draft read route. The mailbox remains
 * part of the caller's cache namespace even though the API resolves it from
 * the draft's server-side associations.
 */
export async function fetchDraft(
  apiClient: ApiClient,
  mailboxId: string,
  draftId: string,
): Promise<DraftResponse> {
  const response = await apiClient.fetch<unknown>(
    `/api/v1/drafts/${encodeURIComponent(draftId)}?mailboxId=${encodeURIComponent(mailboxId)}`,
  );
  return draftDetailResponseSchema.parse(response).data;
}

export function draftQuery(
  mailboxId: string,
  draftId: string,
): UseQueryResult<DraftResponse, ApiError> {
  const apiClient = useApiClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useQuery({
    queryKey: mailboxQueryKeys.draft(mailboxId, draftId, userId),
    queryFn: () => fetchDraft(apiClient, mailboxId, draftId),
    enabled: userId !== null,
    staleTime: 0,
  });
}

const mailboxMembersPath = (mailboxId: string): string =>
  `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/members`;

function invalidMailboxMembersResponse(): ApiError {
  return new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
}

/** Fetches the strict, credential-free member projection for one mailbox. */
export async function fetchMailboxMembers(
  apiClient: ApiClient,
  mailboxId: string,
): Promise<MailboxMemberItem[]> {
  const response = await apiClient.fetch<unknown>(mailboxMembersPath(mailboxId));
  try {
    const envelope = response as { readonly data?: unknown };
    return mailboxMemberListResponseSchema.parse(envelope.data).items;
  } catch {
    throw invalidMailboxMembersResponse();
  }
}

/** User-scoped query for the explicit members of one mailbox. */
export function mailboxMembersQuery(
  mailboxId: string,
): UseQueryResult<MailboxMemberItem[], ApiError> {
  const apiClient = useApiClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useQuery({
    queryKey: mailboxQueryKeys.members(mailboxId, userId),
    queryFn: () => fetchMailboxMembers(apiClient, mailboxId),
    enabled: userId !== null,
    staleTime: 0,
  });
}

export interface AddMailboxMemberInput extends AddMailboxMemberRequest {
  readonly mailboxId: string;
}

/** Adds an existing active user to a mailbox and returns the safe member item. */
export async function addMailboxMember(
  apiClient: ApiClient,
  input: AddMailboxMemberInput,
): Promise<MailboxMemberItem> {
  const response = await apiClient.fetch<unknown>(mailboxMembersPath(input.mailboxId), {
    method: 'POST',
    body: { email: input.email, role: input.role },
  });
  try {
    const envelope = response as { readonly data?: unknown };
    return addMailboxMemberResponseSchema.parse(envelope).data;
  } catch {
    throw invalidMailboxMembersResponse();
  }
}

/** Adds a member and mirrors the server's safe response into the current list cache. */
export function useAddMailboxMemberMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useMutation({
    mutationFn: (input: AddMailboxMemberInput) => addMailboxMember(apiClient, input),
    onMutate: async (input): Promise<void> => {
      // Stop a stale list response from overwriting the server-confirmed
      // member after the mutation updates this exact user/mailbox cache.
      await queryClient.cancelQueries({
        queryKey: mailboxQueryKeys.members(input.mailboxId, userId),
        exact: true,
      });
    },
    onSuccess: (member, input) => {
      queryClient.setQueryData<MailboxMemberItem[]>(
        mailboxQueryKeys.members(input.mailboxId, userId),
        (existing) => {
          const current = existing ?? [];
          return [...current.filter((item) => item.userId !== member.userId), member];
        },
      );
    },
  });
}

export interface RemoveMailboxMemberInput {
  readonly mailboxId: string;
  readonly memberUserId: string;
}

/** Removes one explicit member and validates the returned resource identity. */
export async function removeMailboxMember(
  apiClient: ApiClient,
  input: RemoveMailboxMemberInput,
): Promise<void> {
  const response = await apiClient.fetch<unknown>(
    `${mailboxMembersPath(input.mailboxId)}/${encodeURIComponent(input.memberUserId)}`,
    { method: 'DELETE' },
  );
  try {
    const removed = deleteMailboxMemberResponseSchema.parse(response).data;
    if (removed.userId !== input.memberUserId) {
      throw invalidMailboxMembersResponse();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidMailboxMembersResponse();
  }
}

/** Removes one member from the current user's mailbox cache after server success. */
export function useRemoveMailboxMemberMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useMutation({
    mutationFn: (input: RemoveMailboxMemberInput) => removeMailboxMember(apiClient, input),
    onMutate: async (input): Promise<void> => {
      // Stop a stale list response from resurrecting the member after the
      // successful DELETE updates this exact user/mailbox cache.
      await queryClient.cancelQueries({
        queryKey: mailboxQueryKeys.members(input.mailboxId, userId),
        exact: true,
      });
    },
    onSuccess: (_result, input) => {
      queryClient.setQueryData<MailboxMemberItem[]>(
        mailboxQueryKeys.members(input.mailboxId, userId),
        (existing) =>
          existing === undefined
            ? existing
            : existing.filter((item) => item.userId !== input.memberUserId),
      );
    },
  });
}

/**
 * CAP-064 — Draft editor PATCH fetcher.
 *
 * Fires `PATCH /api/v1/drafts/:draftId` with the strict
 * `updateDraftSchema`-shaped body (`subject`, `body_text`, `body_html`,
 * and `to` / `cc` / `bcc` recipient arrays) and an `If-Match: <updated_at>`
 * header carrying the caller-supplied `ifMatch` token. The
 * `Idempotency-Key` and `x-request-id` headers are minted by the shared
 * `ApiClient` (D-CAP-041-1 / D-CAP-041-2); the fetcher never sets them.
 *
 * The response is parsed end-to-end with `draftDetailResponseSchema`
 * (the wire envelope around the strict `draftResponseSchema`). A malformed
 * 2xx body is normalised to the same `INVALID_RESPONSE` code the
 * `useComposeMessageMutation` setter raises so the caller's
 * `ApiError` surface stays stable (R-API-002). The full envelope is
 * parsed in one step so a foreign `data` shape cannot cross the boundary
 * (R-DATA-004).
 *
 * The mailbox id is part of the input only because the caller's draft
 * cache key needs it (cache mirroring is the component's responsibility —
 * see `DraftRecoveryPage`); the route resolves the draft's mailbox from
 * its own server-side association (R-AUTHZ-004), never from this value.
 */
export async function fetchUpdateDraft(
  apiClient: ApiClient,
  input: UpdateDraftInput,
): Promise<DraftResponse> {
  const response = await apiClient.fetch<unknown>(
    `/api/v1/drafts/${encodeURIComponent(input.draftId)}`,
    {
      method: 'PATCH',
      // The wire names are `body_text` / `body_html`; the body's shape
      // is locked by `updateDraftSchema` so a typo or an accidentally
      // cleared `subject` cannot sneak past the parser.
      body: input.body,
      headers: { 'If-Match': input.ifMatch },
    },
  );
  try {
    const draft = draftDetailResponseSchema.parse(response).data;
    if (draft.id !== input.draftId || draft.mailboxId !== input.mailboxId) {
      throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
    }
    return draft;
  } catch {
    // Same posture as `useComposeMessageMutation`: a 2xx body that
    // doesn't match the envelope is a deterministic client-side error,
    // not a raw ZodError leaking out of the network boundary.
    throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
  }
}

export interface UpdateDraftInput {
  /** Draft id from the authenticated draft route (R-AUTHZ-004). */
  readonly draftId: string;
  /** Mailbox scoping from the page; used only for caller cache keying. */
  readonly mailboxId: string;
  /** Server's `updated_at` echoed back as the optimistic-concurrency token. */
  readonly ifMatch: string;
  /** Strict `updateDraftSchema`-shaped PATCH body. */
  readonly body: UpdateDraftRequest;
}

/**
 * CAP-064 — Draft editor PATCH mutation.
 *
 * Mirrors the response into the existing draft query cache (the same
 * `mailboxQueryKeys.draft(mailboxId, draftId)` key `draftQuery` reads) so a
 * successful autosave replaces the displayed server version without a
 * refetch (D-CAP-041-1). On failure the query cache is left untouched; the
 * `ApiError` propagates to the caller (the editor's `Saving` / `Saved` /
 * conflict states). Errors log the typed code and message only —
 * never the body, the recipients, or the response envelope (R-SECRET-003,
 * R-API-002).
 */
export function useUpdateDraftMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useMutation({
    mutationFn: async (input: UpdateDraftInput): Promise<DraftResponse> => {
      return fetchUpdateDraft(apiClient, input);
    },
    onSuccess: (draft, input) => {
      // R-AUTHZ-004: the server only ever echoes the resource the caller
      // is authorised to read; the cache write is keyed on the same
      // path the query uses so the next render reads the saved shape
      // verbatim.
      queryClient.setQueryData<DraftResponse>(
        mailboxQueryKeys.draft(input.mailboxId, input.draftId, userId),
        draft,
      );
    },
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
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useQuery({
    queryKey: mailboxQueryKeys.thread(mailboxId, messageId, userId),
    queryFn: () => fetchMessageThread(apiClient, mailboxId, messageId),
    enabled: userId !== null,
    staleTime: mailboxCachePolicy.thread,
  });
}

export interface MarkMessageReadInput {
  readonly mailboxId: string;
  readonly messageId: string;
  readonly folder?: MessageFolder;
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
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useMutation({
    mutationFn: async (input: MarkMessageReadInput): Promise<void> => {
      await apiClient.fetch(
        `/api/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/messages/${encodeURIComponent(input.messageId)}/read`,
        { method: 'PATCH' },
      );
    },
    onMutate: (input) => cancelMessageViewReads(queryClient, userId, input.mailboxId),
    onSuccess: async (_result, input) => {
      await cancelMessageViewReads(queryClient, userId, input.mailboxId);
      updateMessageViews(queryClient, userId, input.mailboxId, input.messageId, { isRead: 1 });
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
  readonly folder?: MessageFolder;
}

/**
 * Star toggle mutation (CAP-058 / CAP-060 / AC 13 + AC 14).
 *
 * AC 16: the flip is OPTIMISTIC — `onMutate` inverts the row's
 * `isStarred` in the active folder cache before the request flies, so the star
 * responds instantly. `onSuccess` then overwrites the guess with the
 * server's authoritative post-toggle value for the requesting user.
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
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useMutation({
    mutationFn: async (input: ToggleMessageStarInput): Promise<0 | 1> => {
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
      await cancelMessageViewReads(queryClient, userId, input.mailboxId);
      // Structural additive copy — only this message's row changes.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId, userId, input.folder),
        (existing) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                pages: existing.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === input.messageId
                      ? { ...item, isStarred: invertedStar(item.isStarred) }
                      : item,
                  ),
                })),
              },
      );
    },
    onSuccess: async (isStarred, input) => {
      await cancelMessageViewReads(queryClient, userId, input.mailboxId);
      updateMessageViews(queryClient, userId, input.mailboxId, input.messageId, { isStarred });
    },
    onError: (error, input) => {
      // H7: row-scoped inverse flip — undo THIS row's optimistic change
      // only. No snapshot, so a sibling mutation's state (another row's
      // star, or a delete that removed this row) is never clobbered; the
      // functional update no-ops when the row is no longer in the cache.
      queryClient.setQueryData<InfiniteData<MessageListResponse>>(
        mailboxQueryKeys.messages(input.mailboxId, userId, input.folder),
        (existing) =>
          existing === undefined
            ? existing
            : {
                ...existing,
                pages: existing.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === input.messageId
                      ? { ...item, isStarred: invertedStar(item.isStarred) }
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
  readonly folder?: MessageFolder;
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
 * On success the row leaves the active folder cache via structural
 * `setQueryData` (filter, no refetch — D-CAP-041-1), and the message's
 * detail + thread cache entries are dropped so a later visit cannot
 * render a deleted message from cache (the API 404s it). On failure the
 * row stays and the mutation warns once (G9 pattern) — a failed delete
 * is ignorable for rendering, but never silent.
 *
 * Slice 3 fix H11: `onMutate` awaits `cancelQueries` on the active folder key
 * before the request flies — without it, an in-flight list refetch that
 * resolves after the success filter would resurrect the deleted row.
 */
export function useDeleteMessageMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
  return useMutation({
    mutationFn: async (input: DeleteMessageInput): Promise<void> => {
      await apiClient.fetch(
        `/api/v1/mailboxes/${encodeURIComponent(input.mailboxId)}/messages/${encodeURIComponent(input.messageId)}`,
        { method: 'DELETE' },
      );
    },
    onMutate: async (input): Promise<void> => {
      // H11: stop in-flight refetches of the active folder key so the success
      // filter is the last write.
      await cancelMessageViewReads(queryClient, userId, input.mailboxId);
    },
    onSuccess: async (_result, input) => {
      await cancelMessageViewReads(queryClient, userId, input.mailboxId);
      // Soft-deleted-for-this-user messages 404 at the detail and thread
      // routes; cached entries for them must not render again.
      queryClient.removeQueries({
        queryKey: mailboxQueryKeys.message(input.mailboxId, input.messageId, userId),
      });
      queryClient.removeQueries({
        queryKey: mailboxQueryKeys.thread(input.mailboxId, input.messageId, userId),
      });
      updateMessageViews(queryClient, userId, input.mailboxId, input.messageId, null);
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
  readonly bcc?: ReadonlyArray<string>;
  readonly subject: string;
  readonly textBody: string;
  /** Sanitized rich HTML; files are hosted by the editor upload flow. */
  readonly htmlBody: string;
  readonly scheduledAt?: string;
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
 * On success the user-scoped `['mailbox',userId,'messages',mailboxId]` family is
 * invalidated: the sent copy appears in the mailbox's 'sent' folder and
 * the next inbox render refetches. On failure nothing is cached or
 * reset — the caller keeps the form's values and surfaces the error
 * inline (AC 4); the error is user-visible, so unlike the row actions
 * above there is no `console.warn` (nothing is swallowed).
 */
export function useComposeMessageMutation() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const sessionQuery = authSessionQuery();
  const userId = sessionQuery.data?.userId ?? null;
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
            ...(input.bcc?.length ? { bcc: input.bcc.map((address) => ({ address })) } : {}),
            subject: input.subject,
            htmlBody: input.htmlBody,
            ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
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
        throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
      }
      return messageId;
    },
    onSuccess: (_messageId, input) => {
      void queryClient.invalidateQueries({
        queryKey: mailboxQueryKeys.messagesFamily(input.mailboxId, userId),
      });
    },
  });
}
