// apps/web — ComposeEmail (CAP-044 Slice 1 / AC 1–7).
//
// The composer at /mailbox/:mailboxId/compose. Plain-text only
// (D-CAP-044-B): `textBody` is authored, `htmlBody` is always ''.
// Send-only — no draft persistence (D-CAP-044-A).
//
// Form (React Hook Form + zod resolver, AC 2):
//   - To — required, ≥1 valid email; comma-separated input becomes an
//     array. Cc — optional, 0+ valid emails.
//   - Subject — required, non-empty, ≤ 998 chars (RFC 5322 subject cap,
//     same bound as composeRequestSchema).
//   - Body — plain text, ≤ 1,000,000 chars, may be empty.
//   - Every field carries a programmatic <label>; errors render through
//     aria-describedby + role="alert" (the shared Input primitive does
//     this for text fields; the body textarea mirrors it locally — a
//     generic Textarea primitive waits for a second consumer).
//   - `shouldFocusError` (RHF default, set explicitly) focuses the first
//     erroring field on a submitted-but-invalid form.
//
// Emails are `.trim().toLowerCase()`d before submit (R-DATA-001) — the
// same normalisation the contracts emailAddressSchema applies.
//
// Reply mode (AC 5 + AC 6): when `replyToMessageId` is set, the parent
// detail is loaded through the existing `messageDetailQuery` and the
// form is prefilled from `buildReplyContext` (D-CAP-044-C, pure). The
// form mounts only after the parent resolves, so `defaultValues` are
// stable; the `key` remounts it per parent id.
//
// Send lifecycle (AC 4): submit disabled while pending; on 202 the form
// resets, a role="status" confirmation shows the returned messageId,
// and the mailbox's messages queries are invalidated (in the mutation).
// A captured reply context clears with the reset (fix d) so the blank
// follow-up composer sends a fresh message. On error the form KEEPS its
// values and the stable error code + message render inline; retry is
// the user clicking Send again — a new `mutate` call with a fresh
// Idempotency-Key, never an auto-replay.
import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
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
import { Spinner } from '../../components/ui/Spinner';
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
        message: `"${token}" is not a valid email address.`,
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
      message: 'At least one email address is required.',
    });
    return;
  }
  rejectInvalidEmailToken(value, ctx);
});

const ccListSchema = z.string().superRefine(rejectInvalidEmailToken);

const subjectSchema = z
  .string()
  .trim()
  .min(1, 'Subject is required.')
  .max(998, 'Subject must be at most 998 characters.');

const bodySchema = z.string().max(1_000_000, 'Body must be at most 1,000,000 characters.');

const composeFormSchema = z.object({
  to: toListSchema,
  cc: ccListSchema,
  subject: subjectSchema,
  body: bodySchema,
});

type ComposeFormFields = z.infer<typeof composeFormSchema>;

const EMPTY_FORM_VALUES: ComposeFormFields = {
  to: '',
  cc: '',
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
      <p className="mailbox-loading">Loading…</p>
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
        defaultValues={{
          to: prefill.to.join(', '),
          cc: '',
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
        <Card title="Could not load the message" description="The reply cannot be pre-filled.">
          <ErrorPanel
            message={parentQuery.error.message}
            code={parentQuery.error.code}
            onRetry={() => {
              void parentQuery.refetch();
            }}
            retryLabel="Retry"
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
  /** Threading headers for a reply; absent for a fresh compose. */
  readonly replyContext?: { readonly inReplyTo: string; readonly references: string } | undefined;
}

function ComposeForm({ mailboxId, defaultValues, replyContext }: ComposeFormProps): ReactElement {
  const sessionQuery = authSessionQuery();
  const composeMutation = useComposeMessageMutation();
  const [sentMessageId, setSentMessageId] = useState<string | null>(null);
  // Fix pass (d): the reply context is captured as STATE at mount, not
  // read live from the prop. After a successful send the form resets to
  // a blank composer — without clearing this state too, the next send
  // from that blank form would silently carry the OLD inReplyTo /
  // references into an unrelated message.
  const [activeReplyContext, setActiveReplyContext] = useState(replyContext);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ComposeFormFields>({
    resolver: zodResolver(composeFormSchema),
    defaultValues,
    // AC 2: a submitted-but-invalid form focuses the first erroring
    // field (RHF focuses the input it holds a ref for, in field order).
    shouldFocusError: true,
  });

  const onSubmit = handleSubmit((values) => {
    // Fix pass (e): the click→re-render race and RHF's async resolver
    // window can admit a second submit before the disabled button
    // re-renders — two mutate calls would mint two fresh
    // Idempotency-Keys and duplicate the send. Bail while one is in
    // flight.
    if (composeMutation.isPending) {
      return;
    }
    setSentMessageId(null);
    composeMutation.mutate(
      {
        mailboxId,
        // R-DATA-001: normalise before submit. The schema already
        // validated every token; tokens are trimmed by splitEmailList.
        to: splitEmailList(values.to).map((address) => address.toLowerCase()),
        cc: splitEmailList(values.cc).map((address) => address.toLowerCase()),
        // z.string().trim() on the schema output gives the trimmed subject.
        subject: values.subject,
        textBody: values.body,
        htmlBody: '',
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
          // AC 4: reset to a blank composer (fresh or reply alike — the
          // sent reply is gone; the confirmation carries the messageId).
          // Fix pass (d): the cleared reply context degrades the titles
          // to the Compose wording and drops the threading headers.
          setActiveReplyContext(undefined);
          reset(EMPTY_FORM_VALUES);
        },
      },
    );
  });

  const pending = composeMutation.isPending;
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
      <header className="mailbox-header">
        {/* Fix pass (d): the title follows the CLEARED context after a
            reply send — the reset form is a fresh Compose, not a reply. */}
        <h1 className="mailbox-title">{activeReplyContext !== undefined ? 'Reply' : 'Compose'}</h1>
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

      <Card
        title={activeReplyContext !== undefined ? 'Reply to message' : 'New message'}
        description="Plain-text message. Sending queues it for delivery."
      >
        {sentMessageId !== null ? (
          <p className="compose-confirmation" role="status" data-testid="compose-confirmation">
            Message queued for sending (ID {sentMessageId}).
          </p>
        ) : null}

        <form onSubmit={onSubmit} noValidate data-testid="compose-form">
          {/* Fix pass (h): no autoComplete on the recipient fields —
              "email" semantics offer the USER'S OWN address, which is
              wrong for a recipient input. */}
          <Input
            id="compose-to"
            type="text"
            label="To"
            help="One or more email addresses, comma-separated."
            error={errors.to?.message}
            data-testid="compose-to"
            {...register('to')}
          />
          <Input
            id="compose-cc"
            type="text"
            label="Cc"
            help="Optional. Comma-separated email addresses."
            error={errors.cc?.message}
            data-testid="compose-cc"
            {...register('cc')}
          />
          <Input
            id="compose-subject"
            type="text"
            label="Subject"
            error={errors.subject?.message}
            data-testid="compose-subject"
            {...register('subject')}
          />
          {/* No shared Textarea primitive exists; this mirrors Input's
              label / aria-describedby / role="alert" wiring locally. */}
          <div className="wizard-field">
            <label className="input-label" htmlFor="compose-body">
              Body
            </label>
            <textarea
              id="compose-body"
              className="input compose-body"
              rows={12}
              aria-invalid={errors.body !== undefined ? true : undefined}
              aria-describedby={errors.body !== undefined ? 'compose-body-error' : undefined}
              data-testid="compose-body"
              {...register('body')}
            />
            {errors.body !== undefined ? (
              <span id="compose-body-error" className="input-error" role="alert">
                {errors.body.message}
              </span>
            ) : null}
          </div>

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
              type="submit"
              variant="primary"
              disabled={pending}
              aria-busy={pending}
              data-testid="compose-submit"
            >
              {pending ? <Spinner /> : 'Send'}
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}
