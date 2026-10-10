/* Adapted from satnaing/shadcn-admin, e16c87f213a5ba5e45964e9b67c792105ec74d26.
 * Copyright (c) 2024 Sat Naing. MIT: docs/rebuild/licenses/shadcn-admin-MIT.txt. */
import { cn } from '../../../lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-accent motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

export { Skeleton };
