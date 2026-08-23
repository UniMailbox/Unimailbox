// apps/web — InboxListPage.
//
// CAP-043 Slice 1 (AC 8). The paginated inbox view for a single mailbox.
// Built on TanStack Query's `useInfiniteQuery` keyed on
// `['mailbox', mailboxId, 'messages']` (D-CAP-041-1 cache pattern).
//
// State surface (mirrors `MailboxListPage`):
//   - Loading first page — `<InboxListSkeleton />`.
//   - Empty — `<InboxEmpty />` ("Nothing here yet").
//   - Error — `<InboxError />` with retry (calls `refetch`).
//   - Unauthorized — descriptor was `null` after the router guard. We
//     render `<Unauthorized variant="expired" />` so the user can recover
//     via the Sign-in CTA (D-CAP-041-9 fallback for the post-guard
//     expiry). Fix pass F6: this is the *only* null handling — the
//     previous `useEffect` navigate-to-/login double-handled the same
//     state the router guard already owns and fought the component
//     render; it was removed to match MailboxShell's single fallback.
//
// The pagination-forward button (`<button>Load more</button>`) calls
// `fetchNextPage`. When the cursor HMAC fails server-side, the route
// returns 400 INVALID_CURSOR; the client resets its cursor chain by
// calling `refetch()` which restarts from page 1 (the only valid page).
import type { ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MessageListItem } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import {
  mailboxMessagesInfiniteQuery,
  mailboxQueryKeys,
} from './mailbox-queries';
import type { MailboxListItem } from './mailbox-queries';
import { InboxListSkeleton } from './InboxListSkeleton';
import { InboxEmpty } from './InboxEmpty';
import { InboxError } from './InboxError';
import { Card } from '../../components/ui/Card';
import { LogoutButton } from '../auth/LogoutButton';

export interface InboxListPageProps {
  readonly mailboxId: string;
}

export function InboxListPage({ mailboxId }: InboxListPageProps): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return <InboxListSkeleton />;
  }
  // D-CAP-041-9 fallback (fix pass F6): a `null` descriptor after the
  // router guard renders the expired-session surface only — the Sign-in
  // CTA inside <Unauthorized /> is the recovery path. No imperative
  // navigate here; the router's `beforeLoad` owns the redirect under
  // normal navigation.
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  return <InboxListContent mailboxId={mailboxId} />;
}

interface InboxListContentProps {
  readonly mailboxId: string;
}

function InboxListContent({ mailboxId }: InboxListContentProps): ReactElement {
  const sessionQuery = authSessionQuery();
  const query = mailboxMessagesInfiniteQuery(mailboxId);

  // fe-LOW (Slice 1 review, deferred to Slice 2): the card title shows
  // the mailbox ADDRESS, not the raw UUID. The mailbox list is already
  // cached from MailboxListPage (the user navigated through it), so a
  // non-subscribing cache read is enough — a cache miss (direct URL
  // entry) falls back to the UUID rather than firing a fetch here.
  const queryClient = useQueryClient();
  const cachedMailboxes = queryClient.getQueryData<MailboxListItem[]>(
    mailboxQueryKeys.list(),
  );
  const mailboxAddress =
    cachedMailboxes?.find((mailbox) => mailbox.id === mailboxId)?.address ??
    `Mailbox ${mailboxId}`;

  if (query.isLoading && query.data === undefined) {
    return <InboxListSkeleton />;
  }

  if (query.error !== null) {
    // CAP-043 Slice 1 / R-API-005: a 400 INVALID_CURSOR means the
    // cursor chain broke (rotation, or the user pasted a stale cursor
    // into the URL). The only valid recovery is to restart from
    // page 1; we explicitly call `refetch()` (which re-issues the
    // first-page GET) rather than `fetchNextPage()` (which would
    // re-issue the failed cursor). The query key does not change.
    //
    // Fix pass F8: the infinite query's generics are fully inferred, so
    // the error narrows via `instanceof ApiError` — every ApiClient
    // rejection is an ApiError; anything else (network failure) falls
    // back to a generic code.
    const apiError =
      query.error instanceof ApiError
        ? query.error
        : new ApiError('UNKNOWN', query.error.message, 0);
    const refetch = (): void => {
      void query.refetch();
    };
    return (
      <InboxError
        message={apiError.message}
        code={apiError.code}
        onRetry={refetch}
      />
    );
  }

  const items: MessageListItem[] =
    query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="mailbox-shell" data-testid="inbox-list-page">
      <header className="mailbox-header">
        <h1 className="mailbox-title">Inbox</h1>
        <div className="mailbox-header-meta">
          <span data-testid="mailbox-user-email">
            {sessionQuery.data?.email ?? ''}
          </span>
          <LogoutButton />
        </div>
      </header>
      <Card
        title={mailboxAddress}
        description="Messages in this mailbox, newest first."
      >
        {items.length === 0 ? (
          <InboxEmpty />
        ) : (
          <>
            <ul className="inbox-list" data-testid="inbox-list">
              {items.map((item) => (
                <InboxListRow key={item.id} message={item} />
              ))}
            </ul>
            {query.hasNextPage ? (
              <div className="inbox-pagination">
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="inbox-load-more"
                  onClick={() => {
                    void query.fetchNextPage();
                  }}
                  disabled={query.isFetchingNextPage}
                >
                  {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </main>
  );
}

interface InboxListRowProps {
  readonly message: MessageListItem;
}

function InboxListRow({ message }: InboxListRowProps): ReactElement {
  const isUnread = message.isRead === 0;
  return (
    <li
      className={`inbox-list-row${isUnread ? ' inbox-list-row-unread' : ''}`}
      data-testid="inbox-list-row"
      data-message-id={message.id}
    >
      <div className="inbox-list-row-subject">{message.subject}</div>
      <div className="inbox-list-row-meta">
        <span className="inbox-list-row-from">
          {message.fromName !== '' ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress}
        </span>
        <span className="inbox-list-row-date">{message.createdAt}</span>
        {message.isStarred === 1 ? (
          <span className="inbox-list-row-star" data-testid="inbox-star">★</span>
        ) : null}
        {isUnread ? (
          <span className="inbox-list-row-badge" data-testid="inbox-unread-badge">Unread</span>
        ) : null}
      </div>
    </li>
  );
}