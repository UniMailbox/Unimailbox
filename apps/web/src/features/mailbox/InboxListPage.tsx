import { useT } from '../../infrastructure/i18n/locale';
import { useReadingPane } from './reading-pane-context';
import { Badge } from '../../components/ui/shadcn/badge';
import { useInAppShell } from '../../components/layouts/AppShell';
// apps/web — InboxListPage.
//
// CAP-043 Slice 1 (AC 8). The paginated inbox view for a single mailbox.
// Built on TanStack Query's `useInfiniteQuery` keyed on
// `['mailbox', userId, 'messages', mailboxId, folder]` (D-CAP-041-1 /
// CAP-058 / CAP-060 cache pattern).
//
// State surface (data-first since the CAP-044 Slice 3 fix pass (g) —
// the D-CAP-044-L fold-in; the admin pages' contract):
//   - Loading first page — `<InboxListSkeleton />`.
//   - Empty — `<InboxEmpty />` ("Nothing here yet").
//   - Error with NO data — the error panel. INVALID_CURSOR offers
//     "Start over" (see below); every other error offers Retry.
//   - Error WITH data — the rows STAY mounted; the error renders as a
//     banner (role="alert") above the list. A failed background
//     refetch or a failed load-more never wipes loaded pages.
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
// returns 400 INVALID_CURSOR (R-API-005). The recovery is
// `queryClient.resetQueries`, NOT `refetch()`: on an infinite query
// TanStack v5 `refetch()` replays EVERY stored pageParam (page 1 AND
// the broken cursor), so a chain broken mid-walk — e.g. a
// CURSOR_SIGNING_KEY rotation — fails again on every Retry.
// `resetQueries` drops the accumulated chain and restarts from page 1
// (D-CAP-044-L; the same recovery the admin pages shipped).
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { MessageFolder, MessageListItem } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import {
  mailboxMessagesInfiniteQuery,
  mailboxQueryKeys,
  mailboxListQuery,
} from './mailbox-queries';
import { InboxListSkeleton } from './InboxListSkeleton';
import { InboxEmpty } from './InboxEmpty';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Button } from '../../components/ui/Button';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import { AppNav } from '../../components/AppNav';
import { LogoutButton } from '../auth/LogoutButton';
// CAP-058 / CAP-043 Slice 3: the inbox row's per-user star + delete actions.
// Both live here, not on the detail page — detail-page actions ride with
// CAP-044.
import { StarButton } from './StarButton';
import { DeleteMessageButton } from './DeleteMessageButton';

export interface InboxListPageProps {
  readonly mailboxId: string;
  readonly folder?: MessageFolder;
}

export function InboxListPage({ mailboxId, folder = 'inbox' }: InboxListPageProps): ReactElement {
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

  return <InboxListContent mailboxId={mailboxId} folder={folder} />;
}

interface InboxListContentProps {
  readonly mailboxId: string;
  readonly folder: MessageFolder;
}

const FOLDER_OPTIONS: ReadonlyArray<{ readonly value: MessageFolder; readonly label: string }> = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'sent', label: 'Sent' },
  { value: 'drafts', label: 'Drafts' },
  { value: 'archive', label: 'Archive' },
  { value: 'trash', label: 'Trash' },
];

function folderLabel(folder: MessageFolder): string {
  return FOLDER_OPTIONS.find((option) => option.value === folder)?.label ?? 'Inbox';
}

function InboxListContent({ mailboxId, folder }: InboxListContentProps): ReactElement {
  const t = useT();
  const inShell = useInAppShell();
  const sessionQuery = authSessionQuery();
  const query = mailboxMessagesInfiniteQuery(mailboxId, folder);
  const currentFolderLabel = folderLabel(folder);

  // Resolve the display address on direct navigation as well as cached navigation.
  const queryClient = useQueryClient();
  const userId = sessionQuery.data?.userId ?? null;
  const listedMailboxes = mailboxListQuery();
  const cachedMailboxes = listedMailboxes.data;
  const mailboxAddress =
    cachedMailboxes?.find((mailbox) => mailbox.id === mailboxId)?.address ?? 'Mailbox';

  // Fix (g), data-first ordering: `query.data` survives a failed
  // background refetch and a failed load-more, so the accumulated rows
  // keep rendering and the error becomes a banner — never a wipe.
  const hasData = query.data !== undefined;
  const apiError =
    query.error === null
      ? null
      : query.error instanceof ApiError
        ? query.error
        : new ApiError('UNKNOWN', query.error.message, 0);

  // Fix (g) / D-CAP-044-L: INVALID_CURSOR recovery. `refetch()` is the
  // WRONG tool — an infinite query's refetch replays every stored
  // pageParam (page 1 AND the broken cursor), so a chain broken by a
  // CURSOR_SIGNING_KEY rotation fails forever under Retry.
  // `resetQueries` drops the accumulated chain and refetches page 1.
  const startOver = (): void => {
    void queryClient.resetQueries({
      queryKey: mailboxQueryKeys.messages(mailboxId, userId, folder),
    });
  };

  // isPending, not isLoading (fix (b) applied to this file by follow-
  // through): an offline-paused first fetch has isLoading === false with
  // no data and no error, which would fall through to the empty state's
  // "Nothing here yet" — a terminal claim with zero requests completed.
  if (!hasData && query.isPending) {
    return <InboxListSkeleton />;
  }

  if (!hasData && apiError !== null) {
    // R-API-005: a 400 INVALID_CURSOR means the cursor chain broke
    // (rotation, or a stale cursor pasted into the URL); the only valid
    // recovery restarts from page 1. Every other error retries the
    // same request. Fix pass F8 lineage: every ApiClient rejection is
    // an ApiError; anything else (network failure) falls back to a
    // generic code via the `apiError` narrowing above.
    return (
      <main className="auth-page" data-testid="inbox-error">
        <Card
          title={`Could not load ${currentFolderLabel.toLowerCase()}`}
          description={`The ${currentFolderLabel.toLowerCase()} list is unavailable.`}
        >
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={
              apiError.code === 'INVALID_CURSOR'
                ? startOver
                : () => {
                    void query.refetch();
                  }
            }
            retryLabel={apiError.code === 'INVALID_CURSOR' ? t('Start over') : t('Retry')}
            testId="inbox-error-panel"
          />
        </Card>
      </main>
    );
  }

  const items: MessageListItem[] = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className="mailbox-shell" data-testid="inbox-list-page">
      <header className="mailbox-header">
        <div>
          <h1 className="mailbox-title">{t(currentFolderLabel)}</h1>
          <p className="mailbox-subtitle">{mailboxAddress}</p>
        </div>
        <div className="mailbox-header-meta">
          <span data-testid="mailbox-user-email">{sessionQuery.data?.email ?? ''}</span>
          {/* CAP-044 Slice 3 (D-CAP-044-K): the admin link, rendered only
              when the nav probe succeeds (member → nothing). */}
          {!inShell ? <AppNav /> : null}

          {!inShell ? (
            <Link
              to="/mailbox/$mailboxId/compose"
              params={{ mailboxId }}
              className="btn btn-md"
              data-testid="inbox-compose-link"
            >
              {t('Compose')}
            </Link>
          ) : null}
          {!inShell ? <LogoutButton /> : null}
        </div>
      </header>
      {!inShell ? (
        <nav
          className="mailbox-folder-nav"
          aria-label={t('Mailbox folders')}
          data-testid="folder-nav"
        >
          {FOLDER_OPTIONS.map((option) => (
            <Link
              key={option.value}
              to="/mailbox/$mailboxId"
              params={{ mailboxId }}
              search={{ folder: option.value }}
              className="mailbox-folder-link"
              aria-current={option.value === folder ? 'page' : undefined}
              data-testid={`folder-link-${option.value}`}
            >
              {t(option.label)}
            </Link>
          ))}
        </nav>
      ) : null}
      <Card>
        {apiError !== null ? (
          // Fix (g): errors with data on screen render as a banner ABOVE
          // the list; the loaded rows below are never wiped by a failed
          // background refetch or a failed load-more.
          <div className="inbox-error-banner" role="alert" data-testid="inbox-error-banner">
            <p>
              {t('Could not load messages: ')}
              {apiError.message}
            </p>
            {apiError.code === 'INVALID_CURSOR' ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="inbox-start-over"
                onClick={startOver}
              >
                {t('Start over')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                data-testid="inbox-banner-retry"
                onClick={() => {
                  void query.refetch();
                }}
              >
                {t('Retry')}
              </Button>
            )}
          </div>
        ) : null}
        {items.length === 0 ? (
          <InboxEmpty folderLabel={currentFolderLabel} />
        ) : (
          <>
            <ul className="inbox-list" data-testid="inbox-list">
              {items.map((item) => (
                <InboxListRow key={item.id} mailboxId={mailboxId} folder={folder} message={item} />
              ))}
            </ul>
            {query.hasNextPage ? (
              <div className="inbox-pagination">
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="inbox-load-more"
                  onClick={() => {
                    void query.fetchNextPage();
                  }}
                  loading={query.isFetchingNextPage}
                  disabled={query.isFetchingNextPage}
                >
                  {t('Load more')}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </main>
  );
}

interface InboxListRowProps {
  readonly mailboxId: string;
  readonly folder: MessageFolder;
  readonly message: MessageListItem;
}

function InboxListRow({ mailboxId, folder, message }: InboxListRowProps): ReactElement {
  const t = useT();
  const openMessage = useReadingPane();
  const isUnread = message.isRead === 0;
  return (
    <li
      className={`inbox-list-row${isUnread ? ' inbox-list-row-unread' : ''}`}
      data-testid="inbox-list-row"
      data-message-id={message.id}
    >
      <div className="inbox-list-row-subject">
        {folder === 'drafts' ? (
          <Link
            to="/mailbox/$mailboxId/draft/$draftId"
            params={{ mailboxId, draftId: message.id }}
            data-testid="inbox-draft-link"
          >
            {message.subject}
          </Link>
        ) : (
          <Link
            to="/mailbox/$mailboxId/messages/$messageId"
            params={{ mailboxId, messageId: message.id }}
            onClick={(event) => {
              if (
                openMessage &&
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey
              ) {
                event.preventDefault();
                openMessage(message.id);
              }
            }}
          >
            {message.subject}
          </Link>
        )}
      </div>
      <div className="inbox-list-row-meta">
        <span className="inbox-list-row-from">
          {message.fromName !== ''
            ? `${message.fromName} <${message.fromAddress}>`
            : message.fromAddress}
        </span>
        <LocalDateTime className="inbox-list-row-date" value={message.createdAt} />
        {isUnread ? (
          <Badge
            variant="secondary"
            className="inbox-list-row-badge"
            data-testid="inbox-unread-badge"
          >
            {t('Unread')}
          </Badge>
        ) : null}
        {/* Slice 3 fix H12: a DIV container, not a span — the inline
            AlertDialog panel renders a <div class="alert-dialog"> here
            when open, and a div inside a span is invalid HTML (the
            auth-session-storage markup guard asserts the row stays
            valid at every dialog state). */}
        <div className="inbox-list-row-actions">
          {/* CAP-058 / AC 13 + AC 16: the per-user star glyph is the toggle
              itself; the cached isStarred drives its filled/outline state
              and the optimistic flip happens in the mutation. */}
          <StarButton mailboxId={mailboxId} folder={folder} message={message} />
          <DeleteMessageButton mailboxId={mailboxId} folder={folder} message={message} />
        </div>
      </div>
    </li>
  );
}
