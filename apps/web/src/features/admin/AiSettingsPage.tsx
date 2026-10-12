import type { ReactElement } from 'react';
import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { PageHeader } from '../../components/ui/PageHeader';
import { useT } from '../../infrastructure/i18n/locale';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { AiConfigurationPanel } from './AiConfigurationPanel';

export function AiSettingsPage(): ReactElement {
  const t = useT();
  const session = authSessionQuery();
  if (session.data === undefined) return <ContentSkeleton variant="form" />;
  if (session.data === null) return <Unauthorized variant="expired" />;
  return (
    <main className="admin-page" data-testid="admin-ai-page">
      <PageHeader title={t('AI services')} />
      <AiConfigurationPanel />
    </main>
  );
}
