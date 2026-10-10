import { useState } from 'react';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { formatLocalDateTime } from '../../components/ui/LocalDateTime';
import { useT } from '../../infrastructure/i18n/locale';

function localInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function ScheduleSendDialog({
  open,
  onClose,
  onConfirm,
  initialTime,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (time: string) => void;
  initialTime?: string;
  pending?: boolean;
}) {
  const t = useT();
  const [value, setValue] = useState(() =>
    localInput(initialTime ? new Date(initialTime) : new Date(Date.now() + 3600_000)),
  );
  const [invalid, setInvalid] = useState(false);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const afternoon = new Date(tomorrow);
  afternoon.setHours(13);
  const nextMonday = new Date(tomorrow);
  nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7));
  const presets: [string, Date][] = [
    [t('Tomorrow morning'), tomorrow],
    [t('Tomorrow afternoon'), afternoon],
    [t('Monday morning'), nextMonday],
  ];
  function confirm(time: string) {
    const date = new Date(time);
    if (
      !Number.isFinite(date.getTime()) ||
      date.getTime() <= Date.now() ||
      date.getTime() > Date.now() + 365 * 86400_000
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onConfirm(date.toISOString());
  }
  return (
    <EditorDialog
      aboveCompose
      compact
      open={open}
      onOpenChange={(opened) => {
        if (!opened && !pending) onClose();
      }}
      title={t('Schedule send')}
      description={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <div className="grid gap-2">
        {presets.map(([label, date]) => (
          <Button
            key={label}
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => confirm(date.toISOString())}
          >
            <span>{label}</span>
            <span className="ms-auto text-xs font-normal">
              {formatLocalDateTime(date.toISOString())}
            </span>
          </Button>
        ))}
      </div>
      <Input
        id="schedule-send-time"
        type="datetime-local"
        label={t('Date and time')}
        value={value}
        min={localInput(new Date())}
        max={localInput(new Date(Date.now() + 365 * 86400_000))}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        onInput={(event) => {
          // Native date controls can emit input before their change event.
          setValue(event.currentTarget.value);
          setInvalid(false);
        }}
        disabled={pending}
        error={invalid ? 'INVALID_SCHEDULE_TIME' : undefined}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
          {t('Cancel')}
        </Button>
        <Button type="button" onClick={() => confirm(value)} disabled={pending} loading={pending}>
          {t('Confirm schedule')}
        </Button>
      </div>
    </EditorDialog>
  );
}
