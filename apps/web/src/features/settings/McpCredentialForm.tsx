import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { CreateMcpToken, PersonalMcpSettings } from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Label } from '../../components/ui/shadcn/label';
import { Checkbox } from '../../components/ui/shadcn/checkbox';
import { useT } from '../../infrastructure/i18n/locale';

export function McpCredentialForm({
  mailboxes,
  busy,
  onCreate,
}: {
  mailboxes: PersonalMcpSettings['mailboxes'];
  busy: boolean;
  onCreate: (request: CreateMcpToken) => void;
}): ReactElement {
  const t = useT();
  const [label, setLabel] = useState('Local AI agent');
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [allowDraft, setAllowDraft] = useState(false);
  const [allowSend, setAllowSend] = useState(false);
  const [days, setDays] = useState(30);
  const canWrite =
    mailboxIds.length > 0 &&
    mailboxIds.every((id) => mailboxes.some((box) => box.id === id && box.canWrite));
  useEffect(() => {
    if (!canWrite) {
      setAllowDraft(false);
      setAllowSend(false);
    }
  }, [canWrite]);
  return (
    <form
      className="settings-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onCreate({ label, mailboxIds, allowDraft, allowSend, expiresInDays: days });
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        <legend className="mb-3 font-medium">{t('Create agent credential')}</legend>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Input
            id="mcp-personal-label"
            label={t('Credential name')}
            maxLength={80}
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Input
            id="mcp-personal-days"
            label={t('Expires in days')}
            type="number"
            min={1}
            max={90}
            required
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t('Allowed mailboxes')}</legend>
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
            {mailboxes.length === 0 ? (
              <p className="p-2 text-sm text-muted-foreground">
                {t('No accessible mailboxes. Ask an administrator to assign mailbox access.')}
              </p>
            ) : (
              mailboxes.map((box) => (
                <Label
                  key={box.id}
                  className="flex cursor-pointer items-center gap-3 rounded-md p-2 hover:bg-muted"
                >
                  <Checkbox
                    disabled={busy}
                    checked={mailboxIds.includes(box.id)}
                    onCheckedChange={(checked) =>
                      setMailboxIds((ids) =>
                        checked ? [...ids, box.id] : ids.filter((id) => id !== box.id),
                      )
                    }
                  />
                  <span className="min-w-0 break-all">
                    {box.address}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {t(box.canWrite ? 'Read and write available' : 'Read-only mailbox')}
                    </span>
                  </span>
                </Label>
              ))
            )}
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t('Agent permissions')}</legend>
          <div className="rounded-md border p-3 text-sm">
            <strong>{t('Read mail')}</strong>
            <p className="text-xs text-muted-foreground">
              {t('Read access is included for the selected mailboxes.')}
            </p>
          </div>
          <Label className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              disabled={busy || !canWrite}
              checked={allowDraft}
              onCheckedChange={(checked) => setAllowDraft(checked === true)}
            />
            <span>
              {t('Allow drafts and AI replies')}
              <span className="block text-xs font-normal text-muted-foreground">
                {t('Creates drafts for review. Does not grant sending.')}
              </span>
            </span>
          </Label>
          <Label className="flex items-start gap-3 rounded-md border p-3">
            <Checkbox
              disabled={busy || !canWrite}
              checked={allowSend}
              onCheckedChange={(checked) => setAllowSend(checked === true)}
            />
            <span>
              {t('Grant send access')}
              <span className="block text-xs font-normal text-muted-foreground">
                {t(
                  'Allows sending from selected mailboxes. Require human approval before each send.',
                )}
              </span>
            </span>
          </Label>
          {!canWrite && mailboxIds.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('Draft and send access require write permission for every selected mailbox.')}
            </p>
          ) : null}
        </fieldset>
        <Button
          type="submit"
          loading={busy}
          disabled={
            mailboxIds.length === 0 ||
            !label.trim() ||
            days < 1 ||
            days > 90 ||
            !Number.isInteger(days)
          }
        >
          {t('Create credential')}
        </Button>
      </fieldset>
    </form>
  );
}
