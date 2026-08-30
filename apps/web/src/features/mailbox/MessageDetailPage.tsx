// apps/web — MessageDetailPage.
//
// CAP-043 Slice 2 (AC 11 + AC 12). The single-message view at
// /mailbox/:mailboxId/messages/:messageId:
//   - subject / from / to / cc / date / sanitized HTML or text body;
//   - headers section collapsed by default (`<details>`);
//   - MessageThreadPanel listing the thread's messages oldest-first
//     with the active message highlighted and clickable;
//   - auto mark-read on mount: when the message is unread for the
//     calling user, `PATCH .../read` fires exactly once per mount
//     (R-MESSAGE-005) and flips the inbox list cache entry for this
//     message to read (targeted setQueryData, not an invalidation).
//
// State surface (mirrors InboxListPage):
//   - Loading — <MessageDetailSkeleton /> while the detail is in-flight.
//   - Error — <ErrorPanel /> with retry (detail query failure).
//   - Unauthorized — descriptor `null` after the router guard renders
//     <Unauthorized variant="expired" /> (D-CAP-041-9 fallback).
//   - Data — the message detail + thread panel. A thread-query failure
//     does not take the page down; it surfaces an inline retry panel
//     beside the message body.
import { useEffect, useRef, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import {
  messageDetailQuery,
  messageThreadQuery,
  useMarkMessageReadMutation,
} from './mailbox-queries';
import { MessageDetailSkeleton } from './MessageDetailSkeleton';
import { MessageAttachments } from './MessageAttachments';
import { SanitizedMessageHtml } from './SanitizedMessageHtml';
import { MessageThreadPanel } from './MessageThreadPanel';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Card } from '../../components/ui/Card';
import { LogoutButton } from '../auth/LogoutButton';
import type { MessageRecipientInfo } from '@unimailbox/contracts';

export interface MessageDetailPageProps {
  readonly mailboxId: string;
  readonly messageId: string;
}

export function MessageDetailPage({ mailboxId, messageId }: MessageDetailPageProps): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return <MessageDetailSkeleton />;
  }
  // D-CAP-041-9 fallback: a `null` descriptor after the router guard
  // renders the expired-session surface — the Sign-in CTA inside
  // <Unauthorized /> is the recovery path (same as InboxListPage).
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  return <MessageDetailContent mailboxId={mailboxId} messageId={messageId} />;
}

interface MessageDetailContentProps {
  readonly mailboxId: string;
  readonly messageId: string;
}

function MessageDetailContent({ mailboxId, messageId }: MessageDetailContentProps): ReactElement {
  const sessionQuery = authSessionQuery();
  const detailQuery = messageDetailQuery(mailboxId, messageId);
  const threadQuery = messageThreadQuery(mailboxId, messageId);
  const { mutate: markMessageRead } = useMarkMessageReadMutation();

  // AC 12 / R-MESSAGE-005: fire mark-read ONCE per message open. The
  // ref guard holds the message id that was already marked on this
  // component instance, so re-renders (query cache updates, thread
  // arrival) and param changes to a sibling message each behave
  // correctly: the former does not re-fire, the latter fires once for
  // the new id. D-CAP-041-2: ApiClient mints the fresh Idempotency-Key.
  const markedMessageRef = useRef<string | null>(null);
  useEffect(() => {
    const detail = detailQuery.data;
    if (detail === undefined || detail.isRead === 1) {
      return;
    }
    if (markedMessageRef.current === detail.id) {
      return;
    }
    markedMessageRef.current = detail.id;
    markMessageRead({ mailboxId, messageId: detail.id, folder: detail.folder });
  }, [detailQuery.data, mailboxId, markMessageRead]);

  if (detailQuery.isLoading && detailQuery.data === undefined) {
    return <MessageDetailSkeleton />;
  }

  if (detailQuery.error !== null) {
    // messageDetailQuery declares its error type as ApiError (unlike the
    // inbox infinite query, whose error type is un-inferable), so no
    // instanceof narrowing is needed here.
    return (
      <main className="mailbox-shell" data-testid="message-detail-error">
        <Card title="Could not load message" description="The message is unavailable.">
          <ErrorPanel
            message={detailQuery.error.message}
            code={detailQuery.error.code}
            onRetry={() => {
              void detailQuery.refetch();
            }}
            retryLabel="Retry"
            testId="message-detail-error-panel"
          />
        </Card>
      </main>
    );
  }

  const detail = detailQuery.data;
  if (detail === undefined) {
    // Unreachable while loading/error branches sit above; keeps the
    // narrowing below total without a non-null assertion.
    return <MessageDetailSkeleton />;
  }

  return (
    <main className="mailbox-shell" data-testid="message-detail-page">
      <header className="mailbox-header">
        <h1 className="mailbox-title">Message</h1>
        <div className="mailbox-header-meta">
          <span data-testid="mailbox-user-email">{sessionQuery.data?.email ?? ''}</span>
          <LogoutButton />
        </div>
      </header>

      <p className="message-detail-back">
        <Link to="/mailbox/$mailboxId" params={{ mailboxId }}>
          Back to inbox
        </Link>
      </p>

      {/* G10 (fe L2): the Card carries only the subject — the from
          address renders exactly once, in the message-from meta row. */}
      <Card title={detail.subject}>
        <div className="message-detail-meta">
          <p data-testid="message-from">{formatFrom(detail.fromAddress, detail.fromName)}</p>
          <p data-testid="message-to">To: {formatRecipients(detail.recipients.to)}</p>
          {detail.recipients.cc.length > 0 ? (
            <p data-testid="message-cc">Cc: {formatRecipients(detail.recipients.cc)}</p>
          ) : null}
          <p data-testid="message-date">{detail.createdAt}</p>
        </div>

        {detail.htmlBody.trim().length > 0 ? (
          <SanitizedMessageHtml
            htmlBody={detail.htmlBody}
            mailboxId={mailboxId}
            attachments={detail.attachments}
          />
        ) : (
          <pre className="message-detail-body" data-testid="message-body">
            {detail.textBody}
          </pre>
        )}

        <MessageAttachments mailboxId={mailboxId} attachments={detail.attachments} />

        {/* Headers collapsed by default (AC 11). RFC 5322 threading
            headers shown verbatim — the raw values are what the thread
            root resolution (D-CAP-043-C) is computed from. */}
        <details className="message-detail-headers" data-testid="message-headers">
          <summary>Headers</summary>
          <dl>
            <dt>Message-ID</dt>
            <dd data-testid="message-header-message-id">{detail.messageIdHeader ?? '—'}</dd>
            <dt>In-Reply-To</dt>
            <dd data-testid="message-header-in-reply-to">{detail.inReplyToHeader ?? '—'}</dd>
            <dt>References</dt>
            <dd data-testid="message-header-references">{detail.referencesHeader}</dd>
          </dl>
        </details>

        {/* CAP-044 Slice 1 / AC 5: Reply opens the composer pre-filled
            from THIS message (D-CAP-044-C computes the threading
            headers client-side from the detail data). */}
        <div className="message-detail-actions">
          <Link
            to="/mailbox/$mailboxId/compose"
            params={{ mailboxId }}
            search={{ replyTo: messageId }}
            className="btn btn-secondary btn-md"
            data-testid="message-reply-link"
          >
            Reply
          </Link>
        </div>

        {threadQuery.data !== undefined ? (
          <MessageThreadPanel
            mailboxId={mailboxId}
            items={threadQuery.data.items}
            activeMessageId={messageId}
          />
        ) : threadQuery.error !== null ? (
          <div data-testid="message-thread-error">
            <ErrorPanel
              message="The thread could not be loaded."
              code={threadQuery.error.code}
              onRetry={() => {
                void threadQuery.refetch();
              }}
              retryLabel="Retry"
              testId="message-thread-error-panel"
            />
          </div>
        ) : (
          <p className="message-thread-loading" data-testid="message-thread-loading">
            Loading thread…
          </p>
        )}
      </Card>
    </main>
  );
}

function formatFrom(address: string, name: string): string {
  return name !== '' ? `${name} <${address}>` : address;
}

function formatRecipients(recipients: ReadonlyArray<MessageRecipientInfo>): string {
  return recipients.map((r) => formatFrom(r.address, r.displayName)).join(', ');
}
