import { Skeleton } from '../../components/ui/shadcn/skeleton';
import { Spinner } from '../../components/ui/Spinner';
import { useRef, useState, type ReactElement } from 'react';
import { AVATAR_MAX_BYTES, type PersonalPreferences } from '@unimailbox/contracts';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/shadcn/sheet';
import { Avatar, AvatarImage, AvatarFallback } from '../../components/ui/shadcn/avatar';
import { Button } from '../../components/ui/shadcn/button';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { usePersonalSettings } from './personal-settings-context';
import { useT } from '../../infrastructure/i18n/locale';
import { authSessionQuery } from '../auth/auth-queries';
import { mailboxListQuery } from '../mailbox/mailbox-queries';
import { LogoutButton } from '../auth/LogoutButton';
import { ChangePasswordForm } from '../auth/ChangePasswordPage';
import { ApiError } from '../../infrastructure/api/errors';
import { AppearanceControls } from './AppearanceControls';
export function UserAvatar({ className = 'size-8' }: { className?: string }): ReactElement {
  const session = authSessionQuery().data;
  const { avatarUrl } = usePersonalSettings();
  return (
    <Avatar className={className}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" className="object-cover" /> : null}
      <AvatarFallback>{session?.email?.slice(0, 1).toUpperCase() ?? 'U'}</AvatarFallback>
    </Avatar>
  );
}
export function QuickSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const t = useT();
  const personal = usePersonalSettings();
  const session = authSessionQuery().data;
  const mailboxes = mailboxListQuery();
  const [status, setStatus] = useState('');
  const [localError, setLocalError] = useState<ApiError | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const preferences = personal.settings.preferences;
  const disabled = personal.loading || personal.busy;
  async function run(action: () => Promise<void>): Promise<void> {
    setLocalError(null);
    setStatus('Saving…');
    try {
      await action();
      setStatus('Saved');
    } catch (cause) {
      setStatus('');
      setLocalError(
        cause instanceof ApiError
          ? cause
          : new ApiError('INTERNAL', 'Could not save settings', 500),
      );
    }
  }
  function update(patch: Partial<PersonalPreferences>): void {
    void run(() => personal.update(patch));
  }
  const error = localError ?? personal.error;
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) {
          setPasswordOpen(false);
          setStatus('');
          setLocalError(null);
        }
      }}
      modal={false}
    >
      <SheetContent
        className="quick-settings"
        onOpenAutoFocus={() => {
          restoreFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (restoreFocus.current?.isConnected) {
            event.preventDefault();
            restoreFocus.current.focus();
          }
        }}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="quick-settings-heading">
          <SheetTitle>{t('Quick settings')}</SheetTitle>
          <SheetDescription className="sr-only">
            {t('Preferences are saved to your account.')}
          </SheetDescription>
        </div>
        <div className="quick-settings-scroll">
          <section className="quick-profile" aria-label={t('Profile')}>
            <UserAvatar className="size-16 shrink-0" />
            <div className="min-w-0">
              <strong className="block truncate">{session?.displayName || session?.email}</strong>
              <span className="block break-all text-sm text-muted-foreground">
                {session?.email}
              </span>
            </div>
            <div className="col-span-2 flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => fileInput.current?.click()}
              >
                {t('Upload avatar')}
              </Button>
              {personal.settings.avatarVersion ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    void run(() => personal.avatar(null));
                  }}
                >
                  {t('Remove avatar')}
                </Button>
              ) : null}
            </div>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              aria-label={t('Upload avatar')}
              accept="image/png,image/jpeg,image/webp"
              disabled={disabled}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (!file) return;
                if (file.size > AVATAR_MAX_BYTES) {
                  setLocalError(new ApiError('BODY_TOO_LARGE', 'Avatar exceeds limit', 413));
                  return;
                }
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
                  setLocalError(new ApiError('AVATAR_INVALID', 'Invalid avatar', 400));
                  return;
                }
                void run(() => personal.avatar(file));
              }}
            />
            <p className="col-span-2 text-xs text-muted-foreground">
              {t('PNG, JPEG or WebP · up to 2 MB')}
            </p>
          </section>
          {error ? (
            <ErrorPanel
              message="Could not save settings"
              code={error instanceof ApiError ? error.code : 'INTERNAL'}
              onRetry={personal.retry}
            />
          ) : null}
          {personal.loading ? (
            <div
              role="status"
              aria-busy="true"
              aria-label={t('Loading…')}
              className="space-y-6 py-6"
              data-testid="quick-settings-loading"
            >
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} aria-hidden="true" className="space-y-3">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <section className="quick-settings-section">
                <h3>{t('Default mailbox')}</h3>
                <select
                  aria-label={t('Default mailbox')}
                  disabled={disabled || mailboxes.isPending || mailboxes.isError}
                  value={preferences.defaultMailboxId ?? ''}
                  onChange={(event) => update({ defaultMailboxId: event.target.value || null })}
                >
                  <option value="">{t('Automatic')}</option>
                  {mailboxes.data
                    ?.filter((item) => item.status === 'active')
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.address}
                      </option>
                    ))}
                </select>
                {mailboxes.isError ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void mailboxes.refetch();
                    }}
                  >
                    {t('Retry loading mailboxes')}
                  </Button>
                ) : null}
              </section>
              <section className="quick-settings-section">
                <h3>{t('Appearance')}</h3>
                <AppearanceControls />
              </section>
              <SettingsChoices
                title="List density"
                value={preferences.density}
                disabled={disabled}
                options={[
                  ['comfortable', 'Comfortable'],
                  ['compact', 'Compact'],
                ]}
                onChange={(density) =>
                  update({ density: density as PersonalPreferences['density'] })
                }
              />
              <SettingsChoices
                title="Reading pane"
                value={preferences.readingPane}
                disabled={disabled}
                options={[
                  ['none', 'No split'],
                  ['right', 'Right of inbox'],
                  ['bottom', 'Below inbox'],
                ]}
                onChange={(readingPane) =>
                  update({ readingPane: readingPane as PersonalPreferences['readingPane'] })
                }
              />
              <section className="quick-settings-section">
                <h3>{t('Security')}</h3>
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={passwordOpen}
                  onClick={() => setPasswordOpen((value) => !value)}
                >
                  {t('Change password')}
                </Button>
                {passwordOpen ? (
                  <ChangePasswordForm
                    onSuccess={() => {
                      setPasswordOpen(false);
                      setStatus('Password updated.');
                    }}
                  />
                ) : null}
              </section>
            </>
          )}
        </div>
        <footer className="quick-settings-footer">
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-xs text-muted-foreground"
            aria-busy={personal.busy}
          >
            {personal.busy ? <Spinner decorative /> : null}
            {t(personal.busy ? 'Saving…' : status)}
          </span>
          <LogoutButton />
        </footer>
      </SheetContent>
    </Sheet>
  );
}
function SettingsChoices({
  title,
  value,
  options,
  disabled,
  onChange,
}: {
  title: string;
  value: string;
  options: Array<[string, string]>;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  const t = useT();
  return (
    <fieldset className="quick-settings-section">
      <legend>{t(title)}</legend>
      <div className="settings-choices">
        {options.map(([key, label]) => (
          <label key={key} className="settings-choice">
            <input
              type="radio"
              name={title}
              value={key}
              checked={value === key}
              disabled={disabled}
              onChange={() => onChange(key)}
            />
            <span>{t(label)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
