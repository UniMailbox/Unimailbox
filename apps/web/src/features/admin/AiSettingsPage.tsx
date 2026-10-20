import type { ReactElement } from 'react';
import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { McpServiceCard } from './McpServiceCard';
import { AiGovernancePanel } from './AiGovernancePanel';
import { AiConfigurationPanel } from './AiConfigurationPanel';

export function AiSettingsPage(): ReactElement {
  const session = authSessionQuery();
  if (session.data === undefined) return <ContentSkeleton variant="form" />;
  if (session.data === null) return <Unauthorized variant="expired" />;
  return (
    <main className="admin-page admin-ai-page" data-testid="admin-ai-page">
      <AiConfigurationPanel />
      <AiGovernancePanel />
      <McpServiceCard userId={session.data.userId} />
    </main>
  );
}
