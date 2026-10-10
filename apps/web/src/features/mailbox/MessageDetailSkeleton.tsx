import type { ReactElement } from 'react';
import { useT } from '../../infrastructure/i18n/locale';
import { Skeleton } from '../../components/ui/shadcn/skeleton';
import { Card } from '../../components/ui/Card';

export function MessageDetailSkeleton(): ReactElement {
  const t = useT();
  return (
    <main className="mailbox-shell" data-testid="message-detail-skeleton" aria-busy="true">
      <span role="status" className="sr-only">
        {t('Loading message')}
      </span>
      <header className="mailbox-header" aria-hidden="true">
        <Skeleton className="h-7 w-48" />
      </header>
      <Card>
        <div aria-hidden="true" className="space-y-6">
          <div className="space-y-3" data-testid="message-detail-skeleton-header">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <div className="flex gap-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="size-8" />
              ))}
            </div>
          </div>
          <div className="space-y-3 py-4" data-testid="message-detail-skeleton-body">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="mt-6 h-32 w-full" />
          </div>
        </div>
      </Card>
    </main>
  );
}
