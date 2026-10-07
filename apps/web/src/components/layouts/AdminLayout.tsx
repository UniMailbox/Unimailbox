import type { ReactElement, ReactNode } from 'react';
import { AppShell } from './AppShell';
export interface AdminLayoutProps {
  readonly children: ReactNode;
}
export function AdminLayout({ children }: AdminLayoutProps): ReactElement {
  return <AppShell admin>{children}</AppShell>;
}
