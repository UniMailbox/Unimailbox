import { Spinner } from '../../components/ui/Spinner';
import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { Textarea } from '../../components/ui/shadcn/textarea';
// apps/web — mailbox-scoped editor for an existing draft.
//
// The server response remains the initial authority. A local CAP-061 copy is
// selected only after the user explicitly chooses recovery; edits then use a
// short client-side debounce for both local durability and the existing
// optimistic-concurrency PATCH route.
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import { getRouterContext, Link } from '@tanstack/react-router';
import {
  emailAddressSchema,
  type DraftResponse,
  type UpdateDraftRequest,
} from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import {
  decideDraftRecovery,
  getDraftWorkingCopy,
  markDraftWorkingCopySynced,
  removeDraftWorkingCopy,
  saveDraftWorkingCopy,
  type DraftRecoveryDecision,
  type DraftWorkingCopy,
  type DraftWorkingCopyInput,
} from '../../lib/draft-cache';
import { draftQuery, useUpdateDraftMutation } from './mailbox-queries';

export interface DraftRecoveryPageProps {
  readonly mailboxId: string;
  readonly draftId: string;
}

const AUTOSAVE_DEBOUNCE_MS = 500;

function DraftBackLink({ mailboxId }: { readonly mailboxId: string }): ReactElement {
  const t = useT();
  const router = useContext(getRouterContext());
  if (router === null) {
    // The page is also mounted in focused unit tests without a RouterProvider.
    // Keep the same URL as a plain anchor in that harness; production renders
    // the router Link and therefore stays within the SPA.
    return (
      <a href={`/mailbox/${encodeURIComponent(mailboxId)}?folder=drafts`}>{t('Back to drafts')}</a>
    );
  }
  return (
    <Link to="/mailbox/$mailboxId" params={{ mailboxId }} search={{ folder: 'drafts' }}>
      {t('Back to drafts')}
    </Link>
  );
}

interface DraftEditorContent {
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
}

interface PendingCacheSync {
  readonly draft: DraftResponse;
  readonly expectedRevision: number;
  readonly generation: number;
  readonly resourceKey: string;
}

function serverContent(draft: DraftResponse): DraftEditorContent {
  return {
    subject: draft.subject,
    bodyText: draft.body_text,
    bodyHtml: draft.body_html,
    to: draft.to.join(', '),
    cc: draft.cc.join(', '),
    bcc: draft.bcc.join(', '),
  };
}

function localContent(copy: DraftWorkingCopy): DraftEditorContent {
  return {
    subject: copy.subject,
    bodyText: copy.textBody,
    bodyHtml: copy.htmlBody,
    to: copy.to.join(', '),
    cc: copy.cc.join(', '),
    bcc: copy.bcc.join(', '),
  };
}

function splitRecipients(value: string): string[] {
  return value
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
}

function parseRecipientField(value: string, label: string): string[] {
  const addresses = splitRecipients(value);
  const invalid = addresses.find((address) => !emailAddressSchema.safeParse(address).success);
  if (invalid !== undefined) {
    throw new ApiError('INVALID_REQUEST', `${label} contains an invalid email address.`, 400);
  }
  return addresses.map((address) => emailAddressSchema.parse(address));
}

function toPatchBody(content: DraftEditorContent): UpdateDraftRequest {
  return {
    subject: content.subject,
    body_text: content.bodyText,
    body_html: content.bodyHtml,
    to: parseRecipientField(content.to, 'To'),
    cc: parseRecipientField(content.cc, 'Cc'),
    bcc: parseRecipientField(content.bcc, 'Bcc'),
  };
}

function toWorkingCopyInput(
  userId: string,
  mailboxId: string,
  draftId: string,
  content: DraftEditorContent,
): DraftWorkingCopyInput {
  return {
    userId,
    mailboxId,
    draftId,
    subject: content.subject,
    textBody: content.bodyText,
    htmlBody: content.bodyHtml,
    to: parseRecipientField(content.to, 'To'),
    cc: parseRecipientField(content.cc, 'Cc'),
    bcc: parseRecipientField(content.bcc, 'Bcc'),
  };
}

function errorForUnknown(value: unknown, fallback: string): ApiError {
  if (value instanceof ApiError) return value;
  return new ApiError('DRAFT_SAVE_FAILED', value instanceof Error ? value.message : fallback, 0);
}

export function DraftRecoveryPage({ mailboxId, draftId }: DraftRecoveryPageProps): ReactElement {
  const t = useT();
  const sessionQuery = authSessionQuery();
  const query = draftQuery(mailboxId, draftId);
  const updateMutation = useUpdateDraftMutation();
  const userId = sessionQuery.data?.userId ?? null;
  const resourceKey = userId === null ? null : `${userId}\u0000${mailboxId}\u0000${draftId}`;

  const [localCopy, setLocalCopy] = useState<DraftWorkingCopy | null | undefined>(undefined);
  const [cacheError, setCacheError] = useState<Error | null>(null);
  const [choice, setChoice] = useState<'server' | 'local'>('server');
  const [content, setContent] = useState<DraftEditorContent | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [decisionMade, setDecisionMade] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>(
    'idle',
  );
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [hasEdited, setHasEdited] = useState(false);

  const localLoadKeyRef = useRef<string | null>(null);
  const previousResourceKeyRef = useRef(resourceKey);
  const currentResourceKeyRef = useRef(resourceKey);
  const activeRef = useRef(true);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const cacheReadyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const serverUpdatedAtRef = useRef<string | null>(null);
  const serverBaselineContentRef = useRef<DraftEditorContent | null>(null);
  const saveBlockedRef = useRef(false);
  const pendingCacheSyncRef = useRef<PendingCacheSync | null>(null);

  currentResourceKeyRef.current = resourceKey;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (autosaveTimerRef.current !== null) {
        clearTimeout(autosaveTimerRef.current);
      }
    };
  }, []);

  // Route parameters can change while this component stays mounted. Invalidate
  // queued work before the new draft's query finishes so an old draft cannot
  // write through the new resource's cache/concurrency context.
  useEffect(() => {
    if (previousResourceKeyRef.current === resourceKey) return;
    previousResourceKeyRef.current = resourceKey;
    generationRef.current += 1;
    saveBlockedRef.current = true;
    pendingCacheSyncRef.current = null;
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, [resourceKey]);

  // The query object changes after a successful PATCH. The local recovery
  // decision must not be reloaded in response to that cache update; it is
  // tied to the route/user identity instead.
  useEffect(() => {
    if (resourceKey === null || userId === null) {
      localLoadKeyRef.current = null;
      setLocalCopy(undefined);
      setContent(null);
      return;
    }
    if (query.data === undefined || localLoadKeyRef.current === resourceKey) return;

    localLoadKeyRef.current = resourceKey;
    setChoice('server');
    setActionError(null);
    setCacheError(null);
    setContent(null);
    setDecisionMade(false);
    setIsReloading(false);
    setHasEdited(false);
    generationRef.current += 1;
    saveBlockedRef.current = false;
    pendingCacheSyncRef.current = null;
    serverUpdatedAtRef.current = query.data.updated_at;

    const server = query.data;
    const baseline = serverContent(server);
    serverBaselineContentRef.current = baseline;
    cacheReadyRef.current = getDraftWorkingCopy(userId, mailboxId, draftId)
      .then(async (copy) => {
        if (copy !== null) {
          if (activeRef.current) setLocalCopy(copy);
          return;
        }

        // Establish a clean local base before the first edit. This keeps a
        // failed first PATCH recoverable without changing the CAP-061 schema.
        const saved = await saveDraftWorkingCopy(
          toWorkingCopyInput(userId, mailboxId, draftId, baseline),
        );
        await markDraftWorkingCopySynced(
          userId,
          mailboxId,
          draftId,
          server.updated_at,
          saved.revision,
        );
        if (activeRef.current) setLocalCopy(null);
      })
      .catch((error: unknown) => {
        if (activeRef.current) {
          setCacheError(error instanceof Error ? error : new Error('Draft cache unavailable'));
          setLocalCopy(null);
        }
        throw error;
      });

    void cacheReadyRef.current.catch(() => undefined);
  }, [draftId, mailboxId, query.data, resourceKey, userId]);

  useEffect(() => {
    if (query.data === undefined || localCopy === undefined || content !== null) return;
    if (query.data.id !== draftId || query.data.mailboxId !== mailboxId) return;
    setContent(
      choice === 'local' && localCopy !== null
        ? localContent(localCopy)
        : serverContent(query.data),
    );
  }, [choice, content, draftId, localCopy, mailboxId, query.data]);

  useEffect(() => {
    if (
      query.data !== undefined &&
      query.data.id === draftId &&
      query.data.mailboxId === mailboxId &&
      !updateMutation.isPending &&
      saveState !== 'saving'
    ) {
      serverUpdatedAtRef.current = query.data.updated_at;
    }
  }, [draftId, mailboxId, query.data, saveState, updateMutation.isPending]);

  if (sessionQuery.data === undefined) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-loading">
        <ContentSkeleton variant="compose" />
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
        <Card
          title={t('Could not load draft')}
          description={t('The draft is unavailable right now.')}
        >
          <ErrorPanel
            message={apiError.message}
            code={apiError.code}
            onRetry={() => {
              void query.refetch();
            }}
            retryLabel={t('Retry')}
            testId="draft-recovery-error-panel"
          />
        </Card>
      </main>
    );
  }
  if (
    query.data !== undefined &&
    (query.data.id !== draftId || query.data.mailboxId !== mailboxId)
  ) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-error">
        <Card
          title={t('Could not load draft')}
          description={t('The draft is unavailable right now.')}
        >
          <ErrorPanel message="Draft not found" code="MESSAGE_NOT_FOUND" />
        </Card>
      </main>
    );
  }
  if (query.data === undefined || localCopy === undefined || content === null) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-loading">
        <ContentSkeleton variant="compose" />
      </main>
    );
  }
  if (cacheError !== null) {
    return (
      <main className="mailbox-shell" data-testid="draft-recovery-error">
        <Card
          title={t('Could not load local recovery')}
          description={t('The server draft is unchanged.')}
        >
          <ErrorPanel
            message={cacheError.message}
            code="DRAFT_CACHE_ERROR"
            onRetry={() => {
              setCacheError(null);
              setLocalCopy(null);
            }}
            retryLabel={t('Use server draft')}
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
  const recovery: DraftRecoveryDecision =
    localCopy === null ? 'unchanged' : decideDraftRecovery(localCopy, server.updated_at);
  const recoveryPending = !decisionMade && recovery !== 'unchanged';

  const loadServer = (): void => {
    if (autosaveTimerRef.current !== null) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    generationRef.current += 1;
    const loadGeneration = generationRef.current;
    const loadResourceKey = resourceKey;
    const isCurrentLoad = (): boolean =>
      activeRef.current &&
      generationRef.current === loadGeneration &&
      currentResourceKeyRef.current === loadResourceKey;
    saveBlockedRef.current = true;
    pendingCacheSyncRef.current = null;
    setIsReloading(true);
    setActionError(null);
    // Refresh first. A conflict action must not delete the local copy while
    // still rendering the stale GET response that caused the 412.
    void query
      .refetch()
      .then((refetched) => {
        if (!isCurrentLoad()) return null;
        if (!refetched.isSuccess || refetched.data === undefined) {
          throw refetched.error ?? new ApiError('DRAFT_LOAD_FAILED', 'Could not load draft.', 0);
        }
        const fresh = refetched.data;
        if (fresh.id !== draftId || fresh.mailboxId !== mailboxId) {
          throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
        }
        serverBaselineContentRef.current = serverContent(fresh);
        serverUpdatedAtRef.current = fresh.updated_at;
        return removeDraftWorkingCopy(session.userId, mailboxId, draftId).then(() => fresh);
      })
      .then((fresh) => {
        if (fresh === null || !isCurrentLoad()) return;
        cacheReadyRef.current = Promise.resolve();
        saveBlockedRef.current = false;
        setLocalCopy(null);
        setChoice('server');
        setContent(serverContent(fresh));
        setHasEdited(false);
        setDecisionMade(true);
        setSaveError(null);
        setSaveState('idle');
        setIsReloading(false);
      })
      .catch((error: unknown) => {
        if (activeRef.current) {
          setIsReloading(false);
          setActionError(error instanceof Error ? error : new Error('Could not load server draft'));
        }
      });
  };

  const isCurrentResource = (generation: number): boolean =>
    generation === generationRef.current && currentResourceKeyRef.current === resourceKey;

  const saveDraft = async (nextContent: DraftEditorContent, generation: number): Promise<void> => {
    const currentResourceKey = resourceKey;
    if (
      saveBlockedRef.current ||
      userId === null ||
      currentResourceKey === null ||
      serverUpdatedAtRef.current === null ||
      !isCurrentResource(generation)
    ) {
      return;
    }
    await cacheReadyRef.current;
    if (saveBlockedRef.current || !activeRef.current || !isCurrentResource(generation)) return;

    if (serverBaselineContentRef.current !== null) {
      const existing = await getDraftWorkingCopy(userId, mailboxId, draftId);
      if (existing === null) {
        const baseline = await saveDraftWorkingCopy(
          toWorkingCopyInput(userId, mailboxId, draftId, serverBaselineContentRef.current),
        );
        await markDraftWorkingCopySynced(
          userId,
          mailboxId,
          draftId,
          serverUpdatedAtRef.current,
          baseline.revision,
        );
      }
    }
    const saved = await saveDraftWorkingCopy(
      toWorkingCopyInput(userId, mailboxId, draftId, nextContent),
    );
    if (saveBlockedRef.current || !activeRef.current || !isCurrentResource(generation)) return;
    const result = await updateMutation.mutateAsync({
      draftId,
      mailboxId,
      ifMatch: serverUpdatedAtRef.current,
      body: toPatchBody(nextContent),
    });

    let synced: DraftWorkingCopy;
    try {
      synced = await markDraftWorkingCopySynced(
        userId,
        mailboxId,
        draftId,
        result.updated_at,
        saved.revision,
      );
    } catch (error: unknown) {
      if (activeRef.current && isCurrentResource(generation)) {
        pendingCacheSyncRef.current = {
          draft: result,
          expectedRevision: saved.revision,
          generation,
          resourceKey: currentResourceKey,
        };
        saveBlockedRef.current = true;
        throw new ApiError(
          'DRAFT_CACHE_ERROR',
          error instanceof Error
            ? 'Draft saved, but the local copy could not be synced.'
            : 'Draft saved, but the local copy could not be synced.',
          0,
        );
      }
      return;
    }
    const sameActiveResource =
      activeRef.current && currentResourceKeyRef.current === currentResourceKey;
    if (!sameActiveResource) return;
    serverUpdatedAtRef.current = result.updated_at;
    if (generation !== generationRef.current) return;
    setLocalCopy((previous) => (previous === null ? previous : synced));
    setContent(serverContent(result));
    setSaveError(null);
    setSaveState('saved');
  };

  function scheduleAutosave(nextContent: DraftEditorContent, generation: number): void {
    if (autosaveTimerRef.current !== null) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => saveDraft(nextContent, generation))
        .catch((error: unknown) => {
          if (!activeRef.current) return;
          const typed = errorForUnknown(error, 'Draft could not be saved.');
          setSaveError(typed);
          setSaveState(typed.code === 'STALE_IF_MATCH' ? 'conflict' : 'error');
          if (typed.code === 'STALE_IF_MATCH') saveBlockedRef.current = true;
        });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  const retryCacheSync = async (pending: PendingCacheSync): Promise<void> => {
    if (
      userId === null ||
      pending.resourceKey !== resourceKey ||
      !isCurrentResource(pending.generation)
    ) {
      return;
    }
    const synced = await markDraftWorkingCopySynced(
      userId,
      mailboxId,
      draftId,
      pending.draft.updated_at,
      pending.expectedRevision,
    );
    pendingCacheSyncRef.current = null;
    saveBlockedRef.current = false;
    serverUpdatedAtRef.current = pending.draft.updated_at;
    setLocalCopy((previous) => (previous === null ? previous : synced));
    setContent(serverContent(pending.draft));
    setSaveError(null);
    setSaveState('saved');
  };

  const retrySave = (): void => {
    if (content === null) return;
    const pending = pendingCacheSyncRef.current;
    if (pending !== null) {
      setSaveState('saving');
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => retryCacheSync(pending))
        .catch((error: unknown) => {
          if (!activeRef.current) return;
          setSaveError(errorForUnknown(error, 'Draft cache could not be synced.'));
          setSaveState('error');
        });
      return;
    }
    saveBlockedRef.current = false;
    setSaveError(null);
    setSaveState('saving');
    scheduleAutosave(content, generationRef.current);
  };

  const updateField =
    (field: keyof DraftEditorContent) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      const nextContent = { ...content, [field]: event.target.value };
      setContent(nextContent);
      setHasEdited(true);
      setSaveError(null);
      setSaveState('saving');
      generationRef.current += 1;
      if (!saveBlockedRef.current) scheduleAutosave(nextContent, generationRef.current);
    };

  return (
    <main className="mailbox-shell" data-testid="draft-recovery-page">
      <p className="message-detail-back">
        <DraftBackLink mailboxId={mailboxId} />
      </p>
      <Card title={t('Draft')} description={t('Changes are saved automatically to this draft.')}>
        {!hasEdited && recovery === 'local-ahead' ? (
          <div role="status" data-testid="draft-local-ahead">
            <p>{t('Unsaved changes are available on this device.')}</p>
            <button
              type="button"
              onClick={() => {
                if (localCopy !== null) {
                  setChoice('local');
                  setContent(localContent(localCopy));
                  setDecisionMade(true);
                }
              }}
              data-testid="recover-local"
            >
              {t('Recover local copy')}
            </button>
            <button type="button" onClick={loadServer} data-testid="load-server">
              {t('Load server version')}
            </button>
          </div>
        ) : null}
        {!hasEdited && recovery === 'server-changed' ? (
          <div role="alert" data-testid="draft-server-changed">
            <p>{t('The server version of this draft has changed.')}</p>
            <button type="button" onClick={loadServer} data-testid="load-server">
              {t('Load server version')}
            </button>
          </div>
        ) : null}
        {actionError !== null ? (
          <p role="alert" data-testid="draft-recovery-action-error">
            {actionError.message}
          </p>
        ) : null}
        {saveState === 'saving' ? (
          <p
            role="status"
            aria-busy="true"
            className="flex items-center gap-2"
            data-testid="draft-save-state"
          >
            <Spinner decorative />
            {t('Saving…')}
          </p>
        ) : saveState === 'saved' ? (
          <p role="status" data-testid="draft-save-state">
            {t('Saved')}
          </p>
        ) : null}
        {saveError !== null ? (
          <ErrorPanel
            message={saveError.message}
            code={saveError.code}
            {...(saveState === 'error' ? { onRetry: retrySave } : {})}
            retryLabel={t('Retry save')}
            testId="draft-save-error"
          />
        ) : null}
        {saveState === 'conflict' ? (
          <div role="alert" data-testid="draft-save-conflict">
            <p>{t('A newer server version exists. Reload it before continuing.')}</p>
            <Button
              type="button"
              variant="secondary"
              onClick={loadServer}
              data-testid="draft-conflict-reload"
            >
              {t('Load newer server version')}
            </Button>
          </div>
        ) : null}
        <form
          noValidate
          onSubmit={(event) => event.preventDefault()}
          data-testid="draft-editor-form"
        >
          <Input
            id="draft-to"
            type="text"
            label={t('To')}
            help={t('One or more email addresses, comma-separated.')}
            value={content.to}
            onChange={updateField('to')}
            disabled={
              recoveryPending ||
              isReloading ||
              saveState === 'conflict' ||
              saveError?.code === 'DRAFT_CACHE_ERROR'
            }
            data-testid="draft-to"
          />
          <Input
            id="draft-cc"
            type="text"
            label={t('Cc')}
            help={t('Optional. Comma-separated email addresses.')}
            value={content.cc}
            onChange={updateField('cc')}
            disabled={
              recoveryPending ||
              isReloading ||
              saveState === 'conflict' ||
              saveError?.code === 'DRAFT_CACHE_ERROR'
            }
            data-testid="draft-cc"
          />
          <Input
            id="draft-bcc"
            type="text"
            label={t('Bcc')}
            help={t('Optional. Comma-separated email addresses.')}
            value={content.bcc}
            onChange={updateField('bcc')}
            disabled={
              recoveryPending ||
              isReloading ||
              saveState === 'conflict' ||
              saveError?.code === 'DRAFT_CACHE_ERROR'
            }
            data-testid="draft-bcc"
          />
          <Input
            id="draft-subject"
            type="text"
            label={t('Subject')}
            value={content.subject}
            onChange={updateField('subject')}
            disabled={
              recoveryPending ||
              isReloading ||
              saveState === 'conflict' ||
              saveError?.code === 'DRAFT_CACHE_ERROR'
            }
            data-testid="draft-subject"
          />
          <div className="wizard-field">
            <label className="input-label" htmlFor="draft-body">
              {t('Body')}
            </label>
            <Textarea
              id="draft-body"
              className="input compose-body"
              rows={12}
              value={content.bodyText}
              onChange={updateField('bodyText')}
              disabled={
                recoveryPending ||
                isReloading ||
                saveState === 'conflict' ||
                saveError?.code === 'DRAFT_CACHE_ERROR'
              }
              data-testid="draft-body"
            />
          </div>
        </form>
      </Card>
    </main>
  );
}
