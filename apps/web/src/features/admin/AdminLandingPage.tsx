import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card } from '../../components/ui/Card';
import { SelectField } from '../../components/ui/SelectField';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { adminNavigation } from '../../components/layouts/AppShell';
import { adminDomainsQuery, adminOverviewQuery } from './admin-queries';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
export function AdminLandingPage(): ReactElement {
  const session = authSessionQuery();
  const [domainId, setDomainId] = useState('');
  const domainsQuery = adminDomainsQuery();
  const overviewQuery = adminOverviewQuery(domainId === '' ? undefined : domainId);

  if (session.data === undefined || overviewQuery.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (session.data === null) return <Unauthorized variant="expired" />;

  const overviewError = overviewQuery.error;
  const domainOptions = [
    { value: '', label: 'All domains' },
    ...(domainsQuery.data ?? []).map((domain) => ({ value: domain.id, label: domain.name })),
  ];
  return (
    <main className="admin-page" data-testid="admin-landing">
      <PageHeader title="Overview" description="Monitor mailbox activity across your domains." />
      <Card
        title="Mailbox overview"
        description="Message totals update for the selected domain or the whole installation."
      >
        <div className="overview-toolbar">
          <div className="overview-scope-field">
            <label className="input-label" htmlFor="overview-domain">
              Domain scope
            </label>
            <SelectField
              id="overview-domain"
              label="Domain scope"
              value={domainId}
              onValueChange={setDomainId}
              options={domainOptions}
            />
          </div>
          {domainsQuery.isError ? (
            <span className="configuration-help">
              Domain list unavailable. Showing all domains.
            </span>
          ) : null}
        </div>
        {overviewError !== null ? (
          <ErrorPanel
            message={
              overviewError instanceof Error ? overviewError.message : 'Overview unavailable.'
            }
            code="OVERVIEW_UNAVAILABLE"
            onRetry={() => void overviewQuery.refetch()}
            testId="admin-overview-error"
          />
        ) : overviewQuery.data !== undefined ? (
          <div className="overview-stat-grid" data-testid="admin-overview-stats">
            <OverviewStat label="Total messages" value={overviewQuery.data.stats.totalMessages} />
            <OverviewStat
              label="Unread"
              value={overviewQuery.data.stats.unreadMessages}
              accent="warning"
            />
            <OverviewStat label="Received" value={overviewQuery.data.stats.receivedMessages} />
            <OverviewStat label="Sent" value={overviewQuery.data.stats.sentMessages} />
            <OverviewStat label="Drafts" value={overviewQuery.data.stats.draftMessages} />
            <OverviewStat label="Mailboxes" value={overviewQuery.data.stats.mailboxCount} />
            <OverviewStat label="Domains" value={overviewQuery.data.stats.domainCount} />
          </div>
        ) : null}
      </Card>

      <section className="admin-overview-links" aria-labelledby="admin-overview-manage">
        <div className="resource-row-header">
          <div>
            <h2 id="admin-overview-manage">Manage</h2>
            <p className="resource-row-description">
              Configure the installation and delivery workflow.
            </p>
          </div>
        </div>
        <ul className="resource-grid">
          {adminNavigation
            .filter((item) => item.to !== '/admin')
            .map((item) => (
              <li key={item.to}>
                <Link to={item.to} data-testid={`admin-${item.to.split('/').at(-1)}-link`}>
                  <item.icon aria-hidden="true" />
                  <h2>{item.label}</h2>
                  <p>{item.description}</p>
                </Link>
              </li>
            ))}
        </ul>
      </section>
    </main>
  );
}

function OverviewStat({
  label,
  value,
  accent,
}: {
  readonly label: string;
  readonly value: number;
  readonly accent?: 'warning';
}): ReactElement {
  return (
    <div className={`overview-stat${accent === undefined ? '' : ` overview-stat-${accent}`}`}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}
