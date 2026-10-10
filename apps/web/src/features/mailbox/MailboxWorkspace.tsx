import { useState, type ReactElement } from 'react';
import { X } from 'lucide-react';
import type { MessageFolder } from '@unimailbox/contracts';
import { usePersonalSettings } from '../settings/personal-settings-context';
import { useT } from '../../infrastructure/i18n/locale';
import { Button } from '../../components/ui/shadcn/button';
import { ScheduledSendsPage } from './ScheduledSendsPage';
import { InboxListPage } from './InboxListPage';
import { MessageDetailPage } from './MessageDetailPage';
import { ReadingPaneContext } from './reading-pane-context';
export function MailboxWorkspace({
  mailboxId,
  folder,
}: {
  mailboxId: string;
  folder: MessageFolder;
}): ReactElement {
  if (folder === 'scheduled') return <ScheduledSendsPage key={mailboxId} mailboxId={mailboxId} />;
  return <MailboxPanes key={`${mailboxId}:${folder}`} mailboxId={mailboxId} folder={folder} />;
}
function MailboxPanes({
  mailboxId,
  folder,
}: {
  mailboxId: string;
  folder: MessageFolder;
}): ReactElement {
  const t = useT();
  const pane = usePersonalSettings().settings.preferences.readingPane;
  const [selected, setSelected] = useState<string | null>(null);
  const split = pane !== 'none' && folder !== 'drafts';
  return (
    <ReadingPaneContext.Provider value={split ? setSelected : null}>
      <div
        className={`mail-workspace${split ? ` mail-workspace-${pane}` : ''}${selected ? ' mail-workspace-selected' : ''}`}
      >
        <div className="reading-list">
          <InboxListPage mailboxId={mailboxId} folder={folder} />
        </div>
        {split ? (
          <section className="reading-detail" aria-label={t('Reading pane')}>
            {selected ? (
              <>
                <div className="reading-pane-toolbar">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(null)}
                    aria-label={t('Close reading pane')}
                  >
                    <X className="size-4" />
                    {t('Close reading pane')}
                  </Button>
                </div>
                <MessageDetailPage mailboxId={mailboxId} messageId={selected} />
              </>
            ) : (
              <p className="reading-placeholder">{t('Select a message to read')}</p>
            )}
          </section>
        ) : null}
      </div>
    </ReadingPaneContext.Provider>
  );
}
