import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { SelectField } from '../../components/ui/SelectField';
import { Input as PrimitiveInput } from '../../components/ui/shadcn/input';
import { PageHeader } from '../../components/ui/PageHeader';
import { CheckCircle2, Cloud, ExternalLink } from 'lucide-react';
// apps/web — managed-domain administration (CAP-066).
//
// The page is session-gated by the router, while domain.read/domain.manage
// remain server-authoritative. Verification is described as operator
// confirmation because Phase 1 has no Cloudflare API integration.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createManagedDomainRequestSchema, type ManagedDomain } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { AlertDialog } from '../../components/ui/AlertDialog';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
import {
  adminDomainsQuery,
  adminConnectionsQuery,
  adminQueryKeys,
  createManagedDomain,
  deleteManagedDomain,
  updateManagedDomainOutboundConnection,
  verifyManagedDomain,
} from './admin-queries';

export function DomainsPage(): ReactElement {
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }
  return <DomainsContent />;
}

function DomainsContent(): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const query = adminDomainsQuery();
  const connectionsQuery = adminConnectionsQuery();
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedDomain | null>(null);
  const [routingConfirmed, setRoutingConfirmed] = useState<ReadonlySet<string>>(new Set());
  const domainNameInputRef = useRef<HTMLInputElement>(null);
  const userId = session?.userId ?? 'anonymous';
  const domainsKey = adminQueryKeys.domains(userId);

  const addMutation = useMutation({
    mutationFn: (domainName: string) => createManagedDomain(apiClient, domainName),
    onMutate: () => {
      setAddError(null);
      setNotice(null);
    },
    onSuccess: async (domain) => {
      await queryClient.cancelQueries({ queryKey: domainsKey });
      queryClient.setQueryData<ManagedDomain[]>(domainsKey, (current) => [
        domain,
        ...(current ?? []),
      ]);
      setName('');
      setNotice(t('Added {value0}.', { value0: domain.name }));
    },
    onError: (error) => {
      setAddError(normalizeApiError(error));
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (domainId: string) => verifyManagedDomain(apiClient, domainId),
    onMutate: () => {
      setActionError(null);
      setNotice(null);
    },
    onSuccess: (result) => {
      const confirmed = (query.data ?? []).find((domain) => domain.name === result.domain);
      if (confirmed !== undefined) {
        setRoutingConfirmed((current) => new Set(current).add(confirmed.id));
      }
      setNotice(t('Operator confirmation recorded for {value0}.', { value0: result.domain }));
    },
    onError: (error) => {
      setActionError(normalizeApiError(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (domainId: string) => deleteManagedDomain(apiClient, domainId),
    onMutate: () => {
      setActionError(null);
      setNotice(null);
    },
    onSuccess: async (result) => {
      await queryClient.cancelQueries({ queryKey: domainsKey });
      queryClient.setQueryData<ManagedDomain[]>(domainsKey, (current) =>
        (current ?? []).filter((domain) => domain.id !== result.id),
      );
      setDeleteTarget(null);
      setNotice(t('Domain deleted.'));
    },
    onError: (error) => {
      setActionError(normalizeApiError(error));
    },
  });

  const outboundMutation = useMutation({
    mutationFn: ({
      domain,
      connectionId,
    }: {
      domain: ManagedDomain;
      connectionId: string | null;
    }) =>
      updateManagedDomainOutboundConnection(apiClient, domain.id, connectionId, domain.updatedAt),
    onMutate: () => {
      setActionError(null);
      setNotice(null);
    },
    onSuccess: async (updated) => {
      await queryClient.cancelQueries({ queryKey: domainsKey });
      queryClient.setQueryData<ManagedDomain[]>(domainsKey, (current) =>
        (current ?? []).map((domain) => (domain.id === updated.id ? updated : domain)),
      );
      setNotice(t('Outbound connection updated for {value0}.', { value0: updated.name }));
    },
    onError: (error) => {
      setActionError(normalizeApiError(error));
    },
  });

  useEffect(() => {
    if (deleteMutation.isSuccess) {
      // A successful delete removes the trigger button's row before the
      // dialog unmounts, so the generic dialog cannot restore focus there.
      // Keep keyboard navigation in the domain-management task instead.
      domainNameInputRef.current?.focus();
    }
  }, [deleteMutation.isSuccess]);

  const submitAdd = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = createManagedDomainRequestSchema.safeParse({ name });
    if (!parsed.success) {
      setAddError(new ApiError('VALIDATION_ERROR', 'Enter a valid domain name.', 400));
      return;
    }
    addMutation.mutate(parsed.data.name);
  };

  const queryError = query.error === null ? null : normalizeApiError(query.error);
  const hasData = query.data !== undefined;
  if (!hasData && query.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (queryError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title={t('Administrator access required')}
          description={t('Your account does not have permission to read managed domains.')}
        >
          <p>{t('Ask an administrator if you need access to this area.')}</p>
        </Card>
      </main>
    );
  }
  if (!hasData && queryError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <PageHeader title={t('Domains')} />
        <Card
          title={t('Could not load domains')}
          description={t('Managed domains are unavailable.')}
        >
          <ErrorPanel
            message={queryError.message}
            code={queryError.code}
            onRetry={() => void query.refetch()}
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const domains = query.data ?? [];
  const connections = connectionsQuery.data ?? [];
  return (
    <main className="admin-page" data-testid="admin-domains-page">
      <PageHeader title={t('Domains')} />
      <Card
        title={t('Connect Cloudflare Email Routing')}
        description={t('Point inbound mail for each managed domain to this Worker.')}
      >
        <div className="cloudflare-flow" data-testid="cloudflare-routing-flow">
          <div className="cloudflare-flow-step">
            <span className="cloudflare-flow-index">1</span>
            <div>
              <strong>{t('Open Cloudflare')}</strong>
              <p>
                {t('In Email Routing, choose the managed domain and route mail to this Worker.')}
              </p>
              <a
                className="btn btn-secondary cloudflare-dashboard-link"
                href="https://dash.cloudflare.com"
                target="_blank"
                rel="noreferrer"
              >
                <Cloud aria-hidden="true" />
                {t('Open Cloudflare dashboard ')}
                <ExternalLink aria-hidden="true" />
              </a>
            </div>
          </div>
          <div className="cloudflare-flow-step">
            <span className="cloudflare-flow-index">2</span>
            <div>
              <strong>{t('Confirm the routing rule')}</strong>
              <p>{t('After saving the rule, confirm it beside the matching domain below.')}</p>
            </div>
          </div>
          <p className="configuration-note">
            {t(
              'Confirmation records the operator action. Delivery is proven when an inbound test email arrives.',
            )}
          </p>
        </div>
      </Card>
      <Card title={t('Managed domains')}>
        <p className="configuration-note" data-testid="domain-verify-note">
          {t('Verification records your confirmation; DNS and delivery are not tested.')}
        </p>
        <form onSubmit={submitAdd} className="admin-form" noValidate>
          <label htmlFor="managed-domain-name">{t('Domain name')}</label>
          <div className="admin-form-row">
            <PrimitiveInput
              id="managed-domain-name"
              ref={domainNameInputRef}
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={addError === null ? undefined : 'domain-add-error'}
            />
            <Button type="submit" loading={addMutation.isPending} disabled={addMutation.isPending}>
              {addMutation.isPending ? t('Adding…') : t('Add domain')}
            </Button>
          </div>
          {addError !== null ? (
            <div className="admin-error-banner" role="alert" data-testid="domain-add-error">
              <span>{addError.message}</span> <span>{addError.code}</span>
            </div>
          ) : null}
        </form>
        {notice !== null ? (
          <p role="status" className="admin-success" data-testid="domain-success">
            {notice}
          </p>
        ) : null}
        {actionError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="domain-action-error">
            <span>{actionError.message}</span> <span>{actionError.code}</span>
          </div>
        ) : null}
        {queryError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="domains-query-error">
            <span>
              {t('Could not refresh domains: ')}
              {queryError.message}
            </span>{' '}
            <span>{queryError.code}</span>
            <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
              {t('Retry')}
            </Button>
          </div>
        ) : null}
        {domains.length === 0 ? (
          <p data-testid="admin-domains-empty">{t('No managed domains exist yet.')}</p>
        ) : (
          <ul className="admin-domain-list" data-testid="admin-domains-list">
            {domains.map((domain) => (
              <li
                key={domain.id}
                className="admin-domain-row"
                data-testid="admin-domain-row"
                data-domain-id={domain.id}
              >
                <div>
                  <strong>{domain.name}</strong>
                  <span className={`admin-domain-status admin-domain-status-${domain.status}`}>
                    {t(domain.status)}
                  </span>
                  <small>
                    {t('Updated ')}
                    <LocalDateTime value={domain.updatedAt} />
                  </small>
                </div>
                <label className="admin-domain-connection-field">
                  <span>{t('Outbound connection')}</span>
                  <SelectField
                    label={t('Outbound connection for {value0}', { value0: domain.name })}
                    value={domain.outboundConnectionId ?? ''}
                    disabled={connectionsQuery.isPending || outboundMutation.isPending}
                    onValueChange={(value) =>
                      outboundMutation.mutate({ domain, connectionId: value === '' ? null : value })
                    }
                    options={[
                      { value: '', label: 'No connection' },
                      ...connections.map((connection) => ({
                        value: connection.id,
                        label: `${connection.label} (${connection.providerKey})${connection.status === 'active' ? '' : ` — ${connection.status}`}`,
                        disabled: connection.status !== 'active',
                      })),
                    ]}
                  />
                  <small className="configuration-help">{t('Saves automatically.')}</small>
                  {connectionsQuery.error !== null ? (
                    <small data-testid="domain-connections-unavailable">
                      {t('Provider connections are unavailable.')}
                    </small>
                  ) : null}
                </label>
                <div className="admin-domain-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => verifyMutation.mutate(domain.id)}
                    loading={verifyMutation.isPending}
                    disabled={
                      verifyMutation.isPending ||
                      deleteMutation.isPending ||
                      routingConfirmed.has(domain.id)
                    }
                    aria-label={t('Verify {value0}', { value0: domain.name })}
                  >
                    {routingConfirmed.has(domain.id) ? (
                      <>
                        <CheckCircle2 aria-hidden="true" /> {t('Routing confirmed ')}
                      </>
                    ) : verifyMutation.isPending ? (
                      t('Confirming…')
                    ) : (
                      t('Confirm routing')
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => setDeleteTarget(domain)}
                    disabled={deleteMutation.isPending || verifyMutation.isPending}
                    aria-label={t('Delete {value0}', { value0: domain.name })}
                  >
                    {t('Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <AlertDialog
        open={deleteTarget !== null}
        name="Delete managed domain"
        title={t('Delete this managed domain?')}
        confirmLabel={deleteMutation.isPending ? t('Deleting…') : t('Delete domain')}
        confirmDisabled={deleteMutation.isPending}
        confirmBusy={deleteMutation.isPending}
        error={actionError === null ? undefined : `${actionError.message} (${actionError.code})`}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget.id);
        }}
      >
        <p>{t('This cannot be undone. Domains that still have mailboxes cannot be deleted.')}</p>
      </AlertDialog>
    </main>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('UNKNOWN', error instanceof Error ? error.message : 'Unexpected error.', 0);
}
