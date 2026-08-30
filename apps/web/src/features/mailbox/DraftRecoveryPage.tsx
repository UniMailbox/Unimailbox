// apps/web — server-authoritative draft view and CAP-061 recovery choice.
//
// CAP-062 deliberately renders the existing draft read-only. Editing,
// autosave, send, and discard mutations remain separate capabilities. The
// server response is shown by default; a local copy is only selected after
// an explicit recovery action.
import { useEffect, useState, type ReactElement } from 'react';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import type { ApiError } from '../../infrastructure/api/errors';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import {
  decideDraftRecovery,
  getDraftWorkingCopy,
  removeDraftWorkingCopy,
  type DraftRecoveryDecision,
  type DraftWorkingCopy,
} from '../../lib/draft-cache';
import { draftQuery } from './mailbox-queries';

export interface DraftRecoveryPageProps {
  readonly mailboxId: string;
  readonly draftId: string;
}

interface DraftDisplayContent {
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly bcc: ReadonlyArray<string>;
}

function serverContent(draft: {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly bcc: ReadonlyArray<string>;
}): DraftDisplayContent {
  return {
    subject: draft.subject,
    bodyText: draft.body_text,
    bodyHtml: draft.body_html,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
  };
}

function localContent(copy: DraftWorkingCopy): DraftDisplayContent {
  return {
    subject: copy.subject,
    bodyText: copy.textBody,
    bodyHtml: copy.htmlBody,
    to: copy.to,
    cc: copy.cc,
    bcc: copy.bcc,
  };
}

function formatRecipients(addresses: ReadonlyArray<string>): string {
  return addresses.length === 0 ? 'None' : addresses.join(', ');
}

export function DraftRecoveryPage({ mailboxId, draftId }: DraftRecoveryPageProps): ReactElement {
  const sessionQuery = authSessionQuery();
  const query = draftQuery(mailboxId, draftId);
  const userId = sessionQuery.data?.userId ?? null;
  const [localCopy, setLocalCopy] = useState<DraftWorkingCopy | null | undefined>(undefined);
  const [cacheError, setCacheError] = useState<Error | null>(null);
  const [choice, setChoice] = useState<'server' | 'local'>('server');
  const [actionError, setActionError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChoice('server');
    setActionError(null);
    setCacheError(null);
    setLocalCopy(undefined);

    if (userId === null || query.data === undefined) {
      return () => {
        cancelled = true;
      };
    }

    void getDraftWorkingCopy(userId, mailboxId, draftId)
      .then((copy) => {
        if (!cancelled) setLocalCopy(copy);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCacheError(error instanceof Error ? error : new Error('Draft cache unavailable'));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [draftId, mailboxId, query.data, userId]);

  if (sessionQuery.data === undefined) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-loading">
        <p className="mailbox-loading">Loading draft…</p>
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }
  const session = sessionQuery.data;

  const apiError: ApiError | null = query.error;
  if (apiError !== null && query.data === undefined) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-error">
        <Card title="Could not load draft" description="The draft is unavailable right now.">
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={() => {
              void query.refetch();
            }}
            retryLabel="Retry"
            testId="draft-recovery-error-panel"
          />
        </Card>
      </main>
    );
  }
  if (query.data === undefined || localCopy === undefined) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-loading">
        <p className="mailbox-loading">Loading draft…</p>
      </main>
    );
  }
  if (cacheError !== null) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-error">
        <Card title="Could not load local recovery" description="The server draft is unchanged.">
          <ErrorPanel
            message={cacheError.message}
            code="DRAFT_CACHE_ERROR"
            onRetry={() => {
              setCacheError(null);
              setLocalCopy(null);
            }}
            retryLabel="Use server draft"
            testId="draft-cache-error-panel"
          />
        </Card>
      </main>
    );
  }
  const server = query.data;
  // The API resolves the draft's mailbox from its association, while this
  // page is reached through a mailbox-scoped URL. Never render a draft under
  // a different mailbox path, even when the actor can read both mailboxes.
  if (server.id !== draftId || server.mailboxId !== mailboxId) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-error">
        <Card title="Could not load draft" description="The draft is unavailable right now.">
          <ErrorPanel message="Draft not found" code="MESSAGE_NOT_FOUND" />
        </Card>
      </main>
    );
  }
  const recovery: DraftRecoveryDecision =
    localCopy === null ? 'unchanged' : decideDraftRecovery(localCopy, server.updated_at);
  const content =
    choice === 'local' && localCopy !== null ? localContent(localCopy) : serverContent(server);

  const loadServer = (): void => {
    setActionError(null);
    void removeDraftWorkingCopy(session.userId, mailboxId, draftId)
      .then(() => {
        setLocalCopy(null);
        setChoice('server');
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error : new Error('Could not clear local draft'));
      });
  };

  return (
    <main className="mailbox-shell" data-testid="draft-recovery-page">
      <p className="message-detail-back">
        <a href={`/mailbox/${encodeURIComponent(mailboxId)}?folder=drafts`}>Back to drafts</a>
      </p>
      <Card title="Draft" description="Server draft content is authoritative.">
        {recovery === 'local-ahead' ? (
          <div role="status" data-testid="draft-local-ahead">
            <p>Unsaved changes are available on this device.</p>
            <button type="button" onClick={() => setChoice('local')} data-testid="recover-local">
              Recover local copy
            </button>
            <button type="button" onClick={loadServer} data-testid="load-server">
              Load server version
            </button>
          </div>
        ) : null}
        {recovery === 'server-changed' ? (
          <div role="alert" data-testid="draft-server-changed">
            <p>The server version of this draft has changed.</p>
            <button type="button" onClick={loadServer} data-testid="load-server">
              Load server version
            </button>
          </div>
        ) : null}
        {actionError !== null ? (
          <p role="alert" data-testid="draft-recovery-action-error">
            {actionError.message}
          </p>
        ) : null}
        <dl data-testid="draft-fields">
          <div>
            <dt>Subject</dt>
            <dd data-testid="draft-subject">{content.subject}</dd>
          </div>
          <div>
            <dt>To</dt>
            <dd data-testid="draft-to">{formatRecipients(content.to)}</dd>
          </div>
          <div>
            <dt>Cc</dt>
            <dd data-testid="draft-cc">{formatRecipients(content.cc)}</dd>
          </div>
          <div>
            <dt>Bcc</dt>
            <dd data-testid="draft-bcc">{formatRecipients(content.bcc)}</dd>
          </div>
          <div>
            <dt>Text body</dt>
            <dd>
              <pre data-testid="draft-text-body">{content.bodyText}</pre>
            </dd>
          </div>
          <div>
            <dt>HTML body source</dt>
            <dd>
              <pre data-testid="draft-html-body">{content.bodyHtml}</pre>
            </dd>
          </div>
        </dl>
      </Card>
    </main>
  );
}
