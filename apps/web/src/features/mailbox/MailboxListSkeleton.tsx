import type { ReactElement } from 'react';
import { useT } from '../../infrastructure/i18n/locale';
import { Skeleton } from '../../components/ui/shadcn/skeleton';
import { Card } from '../../components/ui/Card';

export function MailboxListSkeleton(): ReactElement {
  const t = useT();
  return (
    <main className="mailbox-shell" data-testid="mailbox-list-skeleton" aria-busy="true">
      <span role="status" className="sr-only">
        {t('Loading mailboxes')}
      </span>
      <header className="mailbox-header" aria-hidden="true">
        <Skeleton className="h-7 w-32" />
      </header>
      <Card>
        <ul className="mailbox-list pointer-events-none" aria-hidden="true">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="mailbox-list-row" data-testid="mailbox-list-row-skeleton">
              <div className="flex min-h-24 items-center gap-3 p-4">
                <Skeleton className="size-9 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
                <Skeleton className="size-4" />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
