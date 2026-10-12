import { useEffect, useRef, useState } from 'react';
import {
  aiReplyRequestSchema,
  aiReplyResponseSchema,
  type AiReplyRequest,
} from '@unimailbox/contracts';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Button } from '../../components/ui/Button';
import { Label } from '../../components/ui/shadcn/label';
import { Textarea } from '../../components/ui/shadcn/textarea';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { useT } from '../../infrastructure/i18n/locale';

export function aiReplyHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return `<p>${escaped.replace(/\r\n?/g, '\n').replace(/\n/g, '<br>')}</p>`;
}

export function AiReplyDialog({
  mailboxId,
  request,
  onClose,
  onApply,
}: {
  mailboxId: string;
  request: Omit<AiReplyRequest, 'instructions'>;
  onClose: () => void;
  onApply: (text: string) => void;
}) {
  const t = useT();
  const client = useApiClient();
  const [instructions, setInstructions] = useState('');
  const [preview, setPreview] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  function close() {
    controller.current?.abort();
    onClose();
  }
  async function generate() {
    if (controller.current) return;
    const parsed = aiReplyRequestSchema.safeParse({ ...request, instructions });
    if (!parsed.success) {
      setError(
        new ApiError(
          'VALIDATION_ERROR',
          t('Enter a subject and keep the draft under 16,000 characters.'),
          400,
        ),
      );
      return;
    }
    const active = new AbortController();
    controller.current = active;
    setPending(true);
    setError(null);
    setPreview('');
    try {
      const response = await client.fetch<{ data: unknown }>(
        `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/ai-reply`,
        { method: 'POST', body: parsed.data, signal: active.signal, retry: false },
      );
      const result = aiReplyResponseSchema.safeParse(response?.data);
      if (!result.success) throw new ApiError('AI_INVALID_RESPONSE', 'Invalid AI reply', 502);
      if (!active.signal.aborted) setPreview(result.data.text);
    } catch (cause) {
      if (!active.signal.aborted)
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError('AI_UPSTREAM_ERROR', 'Could not generate an AI reply', 502),
        );
    } finally {
      if (!active.signal.aborted) {
        controller.current = null;
        setPending(false);
      }
    }
  }
  return (
    <EditorDialog
      aboveCompose
      open
      title={t(request.sourceMessageId ? 'AI reply' : 'AI draft')}
      description={t(
        'Email content and your instructions are sent to the configured AI service. Review the result before using it.',
      )}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="ai-reply-instructions">{t('Instructions (optional)')}</Label>
        <Textarea
          id="ai-reply-instructions"
          value={instructions}
          maxLength={4000}
          disabled={pending}
          placeholder={t('For example: thank them and ask for the delivery date.')}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </div>
      {pending ? <p role="status">{t('Generating email…')}</p> : null}
      {error ? (
        <>
          <ErrorPanel message={error.message} code={error.code} testId="ai-reply-error" />
          {error.code === 'VALIDATION_ERROR' ? (
            <p>{t('Enter a subject and keep the draft under 16,000 characters.')}</p>
          ) : null}
        </>
      ) : null}
      {preview ? (
        <div className="grid gap-2">
          <Label htmlFor="ai-reply-preview">{t('AI preview')}</Label>
          <Textarea id="ai-reply-preview" value={preview} readOnly rows={10} />
          {request.draftBody.trim() ? (
            <p>{t('Using this result replaces the current body.')}</p>
          ) : null}
        </div>
      ) : null}
      <div className="wizard-actions">
        <Button type="button" disabled={pending} loading={pending} onClick={() => void generate()}>
          {t(preview ? 'Generate again' : 'Generate')}
        </Button>
        {preview ? (
          <Button type="button" variant="secondary" onClick={() => onApply(preview)}>
            {t(request.draftBody.trim() ? 'Replace body' : 'Use this draft')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={close}>
          {t('Cancel')}
        </Button>
      </div>
    </EditorDialog>
  );
}
