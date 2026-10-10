import type { ReactElement } from 'react';
import { useT } from '../../infrastructure/i18n/locale';
import { Skeleton } from '../../components/ui/shadcn/skeleton';
import { Card } from '../../components/ui/Card';

export function InboxListSkeleton(): ReactElement {
  const t = useT();
  return (
    <main className="mailbox-shell" data-testid="inbox-list-skeleton" aria-busy="true">
      <span role="status" className="sr-only">
        {t('Loading inbox')}
      </span>
      <header className="mailbox-header" aria-hidden="true">
        <div className="space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-48" />
        </div>
      </header>
      <Card>
        <ul className="inbox-list pointer-events-none" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => (
            <li key={index} className="inbox-list-row" data-testid="inbox-list-row-skeleton">
              <div className="flex w-full items-center gap-3">
                <Skeleton className="size-4 shrink-0" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
                <Skeleton className="hidden h-3 w-16 sm:block" />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
