// apps/web — MailboxListPage.
//
// CAP-043 Slice 1 (AC 7). Replaces the placeholder `/mailbox` shell with
// a real list of owned mailboxes. The page fetches `GET /api/v1/mailboxes`
// (CAP-020) and renders each entry as a button that navigates to the
// inbox for that mailbox.
//
// Authorization:
//   - The router's `beforeLoad` redirects to `/login` if the auth session
//     is `null`. By the time this component renders, the session is in
//     the cache and the user is signed in.
//   - D-CAP-041-9 fallback (fix pass F5, mirrors MailboxShell): if the
//     descriptor is `null` *after* the guard — session revoked between
//     guard and render — render <Unauthorized variant="expired" /> rather
//     than the empty state, so an expired session never masquerades as
//     "No mailboxes yet."
//   - The mailbox-list endpoint requires `message.read` (enforced
//     server-side by the route's `requirePermission` middleware). 403
//     surfaces as <MailboxError />.
//
// State surface:
//   - Loading — `MailboxListSkeleton` (three skeleton rows).
//   - Empty — `MailboxListEmpty` (CTA to create a mailbox; create lands
//     separately, CAP-044 follow-up).
//   - Error — `MailboxError` with retry; non-401 errors only (401 already
//     redirected by the router).
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import type { MailboxListItem } from './mailbox-queries';
import { mailboxListQuery } from './mailbox-queries';
import { MailboxLoading } from './MailboxLoading';
import { MailboxError } from './MailboxError';
import { Card } from '../../components/ui/Card';
import { AppNav } from '../../components/AppNav';

export function MailboxListPage(): ReactElement {
  const navigate = useNavigate();
  const sessionQuery = authSessionQuery();
  const query = mailboxListQuery();

  // Cache is empty (rare: a fresh navigation with a never-loaded session
  // descriptor). Same branch as MailboxShell — in practice the router's
  // `beforeLoad` already ran `ensureQueryData`.
  if (sessionQuery.data === undefined) {
    return <MailboxLoading />;
  }
  // D-CAP-041-9 fallback (fix pass F5): the router's `beforeLoad`
  // guarantees a non-null descriptor under normal navigation. This branch
  // covers a session that was valid at guard time but revoked before this
  // component mounted — surface the actionable "Session expired" view,
  // NOT the empty state.
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  if (query.data === undefined && query.error === null) {
    return <MailboxLoading />;
  }

  if (query.error !== null) {
    return (
      <MailboxError
        message={query.error.message}
        code={query.error.code}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const items = query.data ?? [];

  return (
    <main className="mailbox-shell" data-testid="mailbox-list-page">
      <header className="mailbox-header">
        <h1 className="mailbox-title">Mailboxes</h1>
        {/* CAP-044 Slice 3 (D-CAP-044-K): the admin link, rendered only
            when the nav probe succeeds (member → nothing). */}
        <div className="mailbox-header-meta">
          <AppNav />
        </div>
      </header>
      <Card
        title="Your mailboxes"
        description="Pick a mailbox to open its inbox."
      >
        {items.length === 0 ? (
          <p data-testid="mailbox-list-empty">No mailboxes yet.</p>
        ) : (
          <ul className="mailbox-list" data-testid="mailbox-list">
            {items.map((item) => (
              <MailboxListRow
                key={item.id}
                mailbox={item}
                onOpen={() => {
                  void navigate({ to: '/mailbox/$mailboxId', params: { mailboxId: item.id } });
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

interface MailboxListRowProps {
  readonly mailbox: MailboxListItem;
  readonly onOpen: () => void;
}

function MailboxListRow({ mailbox, onOpen }: MailboxListRowProps): ReactElement {
  return (
    <li className="mailbox-list-row" data-testid="mailbox-list-row">
      <button
        type="button"
        className="mailbox-list-row-button"
        data-testid="mailbox-list-row-button"
        onClick={onOpen}
      >
        <span className="mailbox-list-row-address">{mailbox.address}</span>
        {mailbox.displayName !== '' ? (
          <span className="mailbox-list-row-display-name">{mailbox.displayName}</span>
        ) : null}
      </button>
    </li>
  );
}