import { useState, type ReactElement, type ReactNode } from 'react';
import { Check, Languages, Moon, Sun } from 'lucide-react';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { Button } from '../../components/ui/shadcn/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/shadcn/dropdown-menu';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { ApiError } from '../../infrastructure/api/errors';
import { setLanguage, useLanguage, useT } from '../../infrastructure/i18n/locale';
import { useAuthSession } from '../auth/auth-session-store';
import { usePersonalSettings } from './personal-settings-context';

/** The same compact controls serve auth, mail, administration and quick settings. */
export function AppearanceControls(): ReactElement {
  const t = useT();
  const language = useLanguage();
  const session = useAuthSession((state) => state.session);
  const personal = usePersonalSettings();
  const authenticated = !!session && !session.mustChangePassword;
  const disabled = authenticated && (personal.loading || personal.busy);
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t('Appearance and language')}>
      <PreferenceMenu
        label="Change language"
        icon={<Languages />}
        value={language}
        disabled={disabled}
        options={[
          { value: 'en', label: 'English' },
          { value: 'zh-CN', label: '简体中文' },
        ]}
        onChange={async (value) => {
          if (authenticated) await personal.update({ language: value });
          else setLanguage(value);
        }}
      />
      {authenticated ? (
        <PreferenceMenu
          label="Change theme"
          icon={
            <>
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
            </>
          }
          value={personal.settings.preferences.theme}
          disabled={disabled}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'System' },
          ]}
          onChange={async (value) => personal.update({ theme: value })}
        />
      ) : (
        <ThemeSwitch />
      )}
    </div>
  );
}

function PreferenceMenu<T extends string>({
  label,
  icon,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  value: T;
  disabled: boolean;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => Promise<void>;
}): ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function select(next: T): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await onChange(next);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError('INTERNAL', 'Save failed', 500));
    } finally {
      setPending(false);
    }
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t(label)}
          title={t(label)}
          disabled={disabled || pending}
          aria-busy={pending}
        >
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[80] max-w-72">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            aria-current={value === option.value ? true : undefined}
            disabled={disabled || pending}
            onSelect={(event) => {
              event.preventDefault();
              void select(option.value);
            }}
          >
            {t(option.label)}
            {value === option.value ? <Check className="ms-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {error ? <ErrorPanel code={error.code} message="Could not save settings" /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
