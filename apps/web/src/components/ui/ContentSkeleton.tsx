import type { ReactElement } from 'react';
import { useT } from '../../infrastructure/i18n/locale';
import { Skeleton } from './shadcn/skeleton';

/** Non-interactive placeholders for the content that is still being fetched. */
export function ContentSkeleton({
  variant = 'list',
}: {
  variant?: 'list' | 'form' | 'overview' | 'compose';
}): ReactElement {
  const t = useT();
  return (
    <div role="status" aria-busy="true" aria-label={t('Loading…')}>
      <span className="sr-only">{t('Loading…')}</span>
      <div aria-hidden="true" className="space-y-6">
        {variant !== 'compose' ? <Skeleton className="h-7 w-40" /> : null}
        {variant === 'overview' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="space-y-4 rounded-xl border p-6">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-16" />
                </div>
              ))}
            </div>
            <Skeleton className="h-64 w-full" />
          </>
        ) : variant === 'form' ? (
          <div className="space-y-6 rounded-xl border p-6">
            <Skeleton className="h-5 w-32" />
            <div className="grid gap-6 sm:grid-cols-2">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
            <Skeleton className="h-9 w-24" />
          </div>
        ) : variant === 'compose' ? (
          <div className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <div className="space-y-4 rounded-md border p-4">
              <Skeleton className="h-8 w-3/4" />
              <Skeleton className="h-56 w-full" />
            </div>
            <Skeleton className="h-9 w-24" />
          </div>
        ) : (
          <>
            <div className="flex justify-between gap-4">
              <Skeleton className="h-9 w-48" />
              <Skeleton className="h-9 w-24" />
            </div>
            <div className="divide-y rounded-xl border">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="flex items-center gap-4 p-4">
                  <Skeleton className="size-8 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                  <Skeleton className="hidden h-6 w-20 sm:block" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
