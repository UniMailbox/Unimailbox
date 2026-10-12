import { Clock } from 'lucide-react';
import { ScheduleSendDialog } from './ScheduleSendDialog';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import { useT } from '../../infrastructure/i18n/locale';
import { errorMessage } from '../../infrastructure/i18n/error-messages';
import { useComposer } from './compose-window-context';
import { useInAppShell } from '../../components/layouts/AppShell';
import { RichTextEditor } from '../../components/editor/RichTextEditor';
import { AiReplyDialog, aiReplyHtml } from './AiReplyDialog';
import { getLanguage } from '../../infrastructure/i18n/locale';
import type { AiReplyRequest } from '@unimailbox/contracts';
import { Sparkles } from 'lucide-react';
import { EDITOR_BODY_MAX_BYTES } from '@unimailbox/contracts';
import { useState, type ReactElement } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { emailAddressSchema } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { buildReplyContext } from './reply-context';
import { messageDetailQuery, useComposeMessageMutation } from './mailbox-queries';
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { LogoutButton } from '../auth/LogoutButton';

/** Comma-separated input → trimmed, non-empty tokens. */
function splitEmailList(value: string): ReadonlyArray<string> {
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

/** Adds a validation issue for the first token that is not an email. */
function rejectInvalidEmailToken(value: string, ctx: z.RefinementCtx): void {
  for (const token of splitEmailList(value)) {
    const parsed = emailAddressSchema.safeParse(token);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'INVALID_EMAIL',
      });
      return;
    }
  }
}

// Two named schemas, not one parameterised one: the To field's only
// extra rule is "at least one address" (coding.md — no config-driven
// branching where a second function does).
const toListSchema = z.string().superRefine((value, ctx) => {
  if (splitEmailList(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'FIELD_REQUIRED',
    });
    return;
  }
  rejectInvalidEmailToken(value, ctx);
});

const ccListSchema = z.string().superRefine(rejectInvalidEmailToken);

const subjectSchema = z.string().trim().min(1, 'FIELD_REQUIRED').max(998, 'SUBJECT_TOO_LONG');

const bodySchema = z.string().max(1_000_000, 'BODY_TOO_LONG');

const composeFormSchema = z.object({
  to: toListSchema,
  cc: ccListSchema,
  bcc: ccListSchema,
  subject: subjectSchema,
  body: bodySchema,
});

type ComposeFormFields = z.infer<typeof composeFormSchema>;

const EMPTY_FORM_VALUES: ComposeFormFields = {
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  body: '',
};

export interface ComposeEmailProps {
  readonly mailboxId: string;
  /** Parent message id from the `?replyTo=` search param; absent = fresh compose. */
  readonly replyToMessageId?: string | undefined;
}

export function ComposeEmail({ mailboxId, replyToMessageId }: ComposeEmailProps): ReactElement {
  const sessionQuery = authSessionQuery();

  if (sessionQuery.data === undefined) {
    return <ComposeSkeleton />;
  }
  // D-CAP-041-9 fallback — same as InboxListPage / MessageDetailPage.
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }

  if (replyToMessageId !== undefined) {
    return <ReplyComposer mailboxId={mailboxId} parentMessageId={replyToMessageId} />;
  }
  return <ComposeForm mailboxId={mailboxId} defaultValues={EMPTY_FORM_VALUES} />;
}

function ComposeSkeleton(): ReactElement {
  return (
    <main className="mailbox-shell" data-testid="compose-skeleton">
      <ContentSkeleton variant="compose" />
    </main>
  );
}

interface ReplyComposerProps {
  readonly mailboxId: string;
  readonly parentMessageId: string;
}

/**
 * Loads the parent message's detail, then mounts the form prefilled per
 * D-CAP-044-C. The form does not mount until the prefill values exist,
 * so the RHF `defaultValues` never change under a mounted form.
 */
function ReplyComposer({ mailboxId, parentMessageId }: ReplyComposerProps): ReactElement {
  const t = useT();
  const parentQuery = messageDetailQuery(mailboxId, parentMessageId);

  // Fix pass (c): data-first ordering. `staleTime: 0` means mounting
  // with a cached parent still fires a background refetch; when that
  // refetch fails, `error` becomes non-null while `data` stays defined.
  // The old error-before-data branch then unmounted the live form —
  // destroying a typed draft — and after a successful send, the
  // invalidation-triggered refetch could tear down the confirmation.
  // The prefilled form renders whenever data exists; the error panel
  // renders only when there is NO data to prefill from.
  const parent = parentQuery.data;
  if (parent !== undefined) {
    const prefill = buildReplyContext(parent);
    return (
      <ComposeForm
        // Remount per parent id: navigating reply A → reply B reuses this
        // component instance, but RHF defaultValues apply at mount only.
        key={parent.id}
        mailboxId={mailboxId}
        sourceMessageId={parent.id}
        defaultValues={{
          to: prefill.to.join(', '),
          cc: '',
          bcc: '',
          subject: prefill.subject,
          body: '',
        }}
        replyContext={
          prefill.inReplyTo !== undefined && prefill.references !== undefined
            ? { inReplyTo: prefill.inReplyTo, references: prefill.references }
            : undefined
        }
      />
    );
  }

  if (parentQuery.error !== null) {
    return (
      <main className="mailbox-shell" data-testid="compose-parent-error">
        <Card
          title={t('Could not load the message')}
          description={t('The reply cannot be pre-filled.')}
        >
          <ErrorPanel
            message={parentQuery.error.message}
            code={parentQuery.error.code}
            onRetry={() => {
              void parentQuery.refetch();
            }}
            retryLabel={t('Retry')}
            testId="compose-parent-error-panel"
          />
        </Card>
      </main>
    );
  }

  // No data and no error yet — the first parent load is still in flight.
  return <ComposeSkeleton />;
}

interface ComposeFormProps {
  readonly mailboxId: string;
  readonly defaultValues: ComposeFormFields;
  readonly sourceMessageId?: string;
  /** Threading headers for a reply; absent for a fresh compose. */
  readonly replyContext?: { readonly inReplyTo: string; readonly references: string } | undefined;
}

function ComposeForm({
  mailboxId,
  defaultValues,
  replyContext,
  sourceMessageId,
}: ComposeFormProps): ReactElement {
  const t = useT();
  const composer = useComposer();
  const inShell = useInAppShell() || Boolean(composer);
  const composeMutation = useComposeMessageMutation();
  const [scheduling, setScheduling] = useState(false);
  const [scheduledTime, setScheduledTime] = useState<string | null>(null);
  const [sentMessageId, setSentMessageId] = useState<string | null>(null);
  // Fix pass (d): the reply context is captured as STATE at mount, not
  // read live from the prop. After a successful send the form resets to
  // a blank composer — without clearing this state too, the next send
  // from that blank form would silently carry the OLD inReplyTo /
  // references into an unrelated message.
  const [activeReplyContext, setActiveReplyContext] = useState(replyContext);
  const [activeSourceId, setActiveSourceId] = useState(sourceMessageId);
  const [aiRequest, setAiRequest] = useState<Omit<AiReplyRequest, 'instructions'> | null>(null);
  const [htmlBody, setHtmlBody] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showCc, setShowCc] = useState(Boolean(defaultValues.cc));
  const [showBcc, setShowBcc] = useState(Boolean(defaultValues.bcc));

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ComposeFormFields>({
    resolver: zodResolver(composeFormSchema),
    defaultValues,
    // AC 2: a submitted-but-invalid form focuses the first erroring
    // field (RHF focuses the input it holds a ref for, in field order).
    shouldFocusError: true,
  });

  const submit = (values: ComposeFormFields, scheduledAt?: string) => {
    // Fix pass (e): the click→re-render race and RHF's async resolver
    // window can admit a second submit before the disabled button
    // re-renders — two mutate calls would mint two fresh
    // Idempotency-Keys and duplicate the send. Bail while one is in
    // flight.
    if (
      composeMutation.isPending ||
      uploading ||
      new TextEncoder().encode(htmlBody).byteLength > EDITOR_BODY_MAX_BYTES
    ) {
      return;
    }
    setSentMessageId(null);
    composeMutation.mutate(
      {
        mailboxId,
        ...(scheduledAt ? { scheduledAt } : {}),
        // R-DATA-001: normalise before submit. The schema already
        // validated every token; tokens are trimmed by splitEmailList.
        to: splitEmailList(values.to).map((address) => address.toLowerCase()),
        cc: splitEmailList(values.cc).map((address) => address.toLowerCase()),
        bcc: splitEmailList(values.bcc).map((address) => address.toLowerCase()),
        // z.string().trim() on the schema output gives the trimmed subject.
        subject: values.subject,
        textBody: values.body,
        htmlBody,
        ...(activeReplyContext !== undefined
          ? {
              inReplyTo: activeReplyContext.inReplyTo,
              references: activeReplyContext.references,
            }
          : {}),
      },
      {
        onSuccess: (messageId) => {
          setSentMessageId(messageId);
          setScheduledTime(scheduledAt ?? null);
          // AC 4: reset to a blank composer (fresh or reply alike — the
          // sent reply is gone; the confirmation carries the messageId).
          // Fix pass (d): the cleared reply context degrades the titles
          // to the Compose wording and drops the threading headers.
          setActiveReplyContext(undefined);
          setActiveSourceId(undefined);
          setAiRequest(null);
          reset(EMPTY_FORM_VALUES);
          setHtmlBody('');
          composer?.sent();
        },
      },
    );
  };
  const onSubmit = handleSubmit((values) => submit(values));

  const pending = composeMutation.isPending || uploading;
  // Every ApiClient rejection is an ApiError; anything else narrows to a
  // generic code (InboxListPage's F8 pattern).
  const mutationError = composeMutation.error;
  const sendError =
    mutationError === null
      ? null
      : mutationError instanceof ApiError
        ? mutationError
        : new ApiError('UNKNOWN', mutationError.message, 0);

  return (
    <main className="mailbox-shell" data-testid="compose-page">
      {!inShell ? (
        <header className="mailbox-header">
          <h1 className="mailbox-title">{activeReplyContext ? t('Reply') : t('Compose')}</h1>
          <LogoutButton />
        </header>
      ) : null}
      <Card
        title={activeReplyContext !== undefined ? t('Reply to message') : t('New message')}
        description={t(
          'Your signature is added automatically. Attachments over 10 MB are sent as download links.',
        )}
      >
        {sentMessageId !== null ? (
          <p className="compose-confirmation" role="status" data-testid="compose-confirmation">
            {scheduledTime ? (
              <>
                {t('Scheduled for')} <LocalDateTime value={scheduledTime} />
              </>
            ) : (
              <>
                {t('Message queued for sending (ID ')}
                {sentMessageId}).
              </>
            )}
          </p>
        ) : null}

        <form onSubmit={onSubmit} noValidate data-testid="compose-form">
          {/* Fix pass (h): no autoComplete on the recipient fields —
              "email" semantics offer the USER'S OWN address, which is
              wrong for a recipient input. */}
          <Input
            id="compose-to"
            type="text"
            label={t('To')}
            placeholder={t('Recipients, separated by commas')}
            className="pe-24"
            endAdornment={
              <>
                {!showCc ? (
                  <button
                    type="button"
                    className="compose-recipient-toggle"
                    onClick={() => setShowCc(true)}
                    aria-label={t('Add Cc')}
                    aria-expanded={showCc}
                  >
                    {t('Cc')}
                  </button>
                ) : null}
                {!showBcc ? (
                  <button
                    type="button"
                    className="compose-recipient-toggle"
                    onClick={() => setShowBcc(true)}
                    aria-label={t('Add Bcc')}
                    aria-expanded={showBcc}
                  >
                    {t('Bcc')}
                  </button>
                ) : null}
              </>
            }
            error={errors.to?.message}
            data-testid="compose-to"
            {...register('to')}
          />
          {showCc ? (
            <Input
              id="compose-cc"
              type="text"
              label={t('Cc')}
              placeholder={t('Cc recipients, separated by commas')}
              error={errors.cc?.message}
              data-testid="compose-cc"
              {...register('cc')}
            />
          ) : null}
          {showBcc ? (
            <Input
              id="compose-bcc"
              type="text"
              label={t('Bcc')}
              placeholder={t('Blind recipients, separated by commas')}
              error={errors.bcc?.message}
              data-testid="compose-bcc"
              {...register('bcc')}
            />
          ) : null}
          <Input
            id="compose-subject"
            type="text"
            label={t('Subject')}
            error={errors.subject?.message}
            data-testid="compose-subject"
            {...register('subject')}
          />
          <RichTextEditor
            id="compose-body"
            label={t('Body')}
            value={htmlBody}
            onChange={(html, text) => {
              setHtmlBody(html);
              setValue('body', text, { shouldDirty: true, shouldValidate: true });
            }}
            scope={{ mailboxId }}
            disabled={composeMutation.isPending}
            onBusyChange={setUploading}
            error={errors.body?.message ? errorMessage(errors.body.message) : undefined}
          />

          {/* AC 4: the stable error code + message render inline; no
              auto-retry — the user edits and clicks Send again. */}
          {sendError !== null ? (
            <ErrorPanel
              message={sendError.message}
              code={sendError.code}
              testId="compose-send-error"
            />
          ) : null}

          <div className="wizard-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() =>
                setAiRequest({
                  ...(activeSourceId ? { sourceMessageId: activeSourceId } : {}),
                  subject: getValues('subject'),
                  draftBody: getValues('body'),
                  language: getLanguage(),
                })
              }
            >
              <Sparkles className="size-4" />
              {t(activeSourceId ? 'AI reply' : 'AI draft')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                pending || new TextEncoder().encode(htmlBody).byteLength > EDITOR_BODY_MAX_BYTES
              }
              loading={pending}
              data-testid="compose-submit"
            >
              {t('Send')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => setScheduling(true)}
              aria-label={t('Schedule send')}
            >
              <Clock className="size-4" />
              {t('Schedule send')}
            </Button>
          </div>
        </form>
      </Card>
      {aiRequest ? (
        <AiReplyDialog
          mailboxId={mailboxId}
          request={aiRequest}
          onClose={() => setAiRequest(null)}
          onApply={(text) => {
            setHtmlBody(aiReplyHtml(text));
            setValue('body', text, { shouldDirty: true, shouldValidate: true });
            setAiRequest(null);
          }}
        />
      ) : null}
      {scheduling ? (
        <ScheduleSendDialog
          open
          onClose={() => setScheduling(false)}
          onConfirm={(time) => {
            setScheduling(false);
            void handleSubmit((values) => submit(values, time))();
          }}
        />
      ) : null}
    </main>
  );
}
