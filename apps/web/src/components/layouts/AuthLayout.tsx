import { useT } from '../../infrastructure/i18n/locale';
import type { ReactNode, ReactElement } from 'react';
import { Mail, Inbox, ShieldCheck, Users } from 'lucide-react';
import { AppearanceControls } from '../../features/settings/AppearanceControls';
/** Split authentication layout adapted from satnaing/shadcn-admin sign-in-2. */
export function AuthLayout({ children }: { children: ReactNode }): ReactElement {
  const t = useT();
  return (
    <div className="auth-layout">
      <aside className="auth-aside">
        <div className="auth-brand">
          <Mail />
          <span>{t('Unimailbox')}</span>
        </div>
        <div>
          <p className="auth-eyebrow">{t('YOUR MAIL WORKSPACE')}</p>
          <h1>
            {t('Email, organized. ')}
            <br />
            {t('Your team, connected. ')}
          </h1>
          <p>{t('One place for your inbox, shared mailboxes, and conversations.')}</p>
          <ul>
            <li>
              <Inbox /> {t('Manage mail across your domains ')}
            </li>
            <li>
              <Users /> {t('Collaborate with shared mailboxes ')}
            </li>
            <li>
              <ShieldCheck /> {t('Keep access under your control ')}
            </li>
          </ul>
        </div>
        <span className="text-sm text-muted-foreground">{t('Unimailbox')}</span>
      </aside>
      <div className="auth-main">
        <header>
          <span className="auth-brand">
            <Mail className="size-5" />
            {t('Unimailbox ')}
          </span>
          <AppearanceControls />
        </header>
        <div className="auth-form-content">{children}</div>
      </div>
    </div>
  );
}
