import type { ReactElement, ReactNode } from 'react';
import { AppShell } from './AppShell';
export interface MailboxLayoutProps {
  readonly children: ReactNode;
}
export function MailboxLayout({ children }: MailboxLayoutProps): ReactElement {
  return <AppShell>{children}</AppShell>;
}
