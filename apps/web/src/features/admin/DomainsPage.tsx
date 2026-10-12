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

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createManagedDomainRequestSchema, type ManagedDomain } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { EditorDialog } from '../../components/ui/EditorDialog';
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
  const [addOpen, setAddOpen] = useState(false);
  const [configureTarget, setConfigureTarget] = useState<ManagedDomain | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedDomain | null>(null);
  const [routingConfirmed, setRoutingConfirmed] = useState<ReadonlySet<string>>(new Set());
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
      setAddOpen(false);
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
      setConfigureTarget(null);
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
      document.querySelector<HTMLButtonElement>('[data-testid="domain-add-trigger"]')?.focus();
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
      <PageHeader
        title={t('Domains')}
        actions={
          <Button
            data-testid="domain-add-trigger"
            onClick={() => {
              setAddError(null);
              setAddOpen(true);
            }}
          >
            {t('Add domain')}
          </Button>
        }
      />
      <Card title={t('Managed domains')}>
        <p className="configuration-note" data-testid="domain-verify-note">
          {t('Verification records your confirmation; DNS and delivery are not tested.')}
        </p>
        {notice !== null ? (
          <p role="status" className="admin-success" data-testid="domain-success">
            {notice}
          </p>
        ) : null}
        {actionError !== null && configureTarget === null && deleteTarget === null ? (
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
                <p className="resource-row-description">
                  {t('Outbound connection')}:{' '}
                  {connections.find((connection) => connection.id === domain.outboundConnectionId)
                    ?.label ??
                    (domain.outboundConnectionId === null
                      ? t('No connection')
                      : t('Provider connections are unavailable.'))}
                </p>
                <div className="admin-domain-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setActionError(null);
                      setConnectionId(domain.outboundConnectionId ?? '');
                      setConfigureTarget(domain);
                    }}
                    aria-label={t('Configure {value0}', { value0: domain.name })}
                  >
                    {t('Configure')}
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
      <EditorDialog
        open={addOpen}
        onOpenChange={(open) => {
          if (addMutation.isPending) return;
          setAddOpen(open);
          if (!open) {
            setName('');
            setAddError(null);
          }
        }}
        title={t('Add domain')}
        description={t('Add a domain to manage its mail routing.')}
        compact
      >
        <form onSubmit={submitAdd} className="admin-form" noValidate>
          <label htmlFor="managed-domain-name">{t('Domain name')}</label>
          <div className="admin-dialog-form">
            <PrimitiveInput
              id="managed-domain-name"
              name="name"
              type="text"
              autoComplete="off"
              disabled={addMutation.isPending}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={addError === null ? undefined : 'domain-add-error'}
            />
            {addError !== null ? (
              <div
                className="admin-error-banner"
                role="alert"
                id="domain-add-error"
                data-testid="domain-add-error"
              >
                <span>{addError.message}</span> <span>{addError.code}</span>
              </div>
            ) : null}
            <div className="admin-dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={addMutation.isPending}
                onClick={() => {
                  setAddOpen(false);
                  setName('');
                  setAddError(null);
                }}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                loading={addMutation.isPending}
                disabled={addMutation.isPending}
              >
                {addMutation.isPending ? t('Adding…') : t('Add domain')}
              </Button>
            </div>
          </div>
        </form>
      </EditorDialog>
      <EditorDialog
        open={configureTarget !== null}
        onOpenChange={(open) => {
          if (!open && !outboundMutation.isPending && !verifyMutation.isPending) {
            setConfigureTarget(null);
            setActionError(null);
          }
        }}
        title={t('Configure domain')}
        description={configureTarget?.name ?? ''}
      >
        {configureTarget !== null ? (
          <div className="admin-dialog-form">
            <form
              id="domain-configuration-form"
              onSubmit={(event) => {
                event.preventDefault();
                outboundMutation.mutate({
                  domain: configureTarget,
                  connectionId: connectionId === '' ? null : connectionId,
                });
              }}
              className="admin-dialog-form"
            >
              <SelectField
                label={t('Outbound connection for {value0}', { value0: configureTarget.name })}
                value={connectionId}
                disabled={
                  connectionsQuery.isPending ||
                  connectionsQuery.isError ||
                  outboundMutation.isPending ||
                  verifyMutation.isPending
                }
                onValueChange={setConnectionId}
                options={[
                  { value: '', label: 'No connection' },
                  ...connections.map((connection) => ({
                    value: connection.id,
                    label: `${connection.label} (${connection.providerKey})${connection.status === 'active' ? '' : ` — ${connection.status}`}`,
                    disabled: connection.status !== 'active',
                  })),
                ]}
              />
              {connectionsQuery.error !== null ? (
                <ErrorPanel
                  message={t('Provider connections are unavailable.')}
                  onRetry={() => void connectionsQuery.refetch()}
                />
              ) : null}
            </form>
            <Card
              title={t('Connect Cloudflare Email Routing')}
              description={t('Point inbound mail for each managed domain to this Worker.')}
              actions={
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => verifyMutation.mutate(configureTarget.id)}
                  loading={verifyMutation.isPending}
                  disabled={
                    verifyMutation.isPending ||
                    outboundMutation.isPending ||
                    routingConfirmed.has(configureTarget.id)
                  }
                  aria-label={t('Verify {value0}', { value0: configureTarget.name })}
                >
                  {routingConfirmed.has(configureTarget.id) ? (
                    <>
                      <CheckCircle2 aria-hidden="true" /> {t('Routing confirmed ')}
                    </>
                  ) : (
                    t('Confirm routing')
                  )}
                </Button>
              }
            >
              <div className="cloudflare-flow" data-testid="cloudflare-routing-flow">
                <div className="cloudflare-flow-step">
                  <span className="cloudflare-flow-index">1</span>
                  <div>
                    <strong>{t('Open Cloudflare')}</strong>
                    <p>
                      {t(
                        'In Email Routing, choose the managed domain and route mail to this Worker.',
                      )}
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
                    <p>{t('After saving the rule, confirm it for this domain.')}</p>
                  </div>
                </div>
                <p className="configuration-note">
                  {t(
                    'Confirmation records the operator action. Delivery is proven when an inbound test email arrives.',
                  )}
                </p>
              </div>
            </Card>
            {notice !== null ? <p role="status">{notice}</p> : null}
            {actionError !== null ? (
              <ErrorPanel message={actionError.message} code={actionError.code} />
            ) : null}
            <div className="admin-dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={outboundMutation.isPending || verifyMutation.isPending}
                onClick={() => {
                  setConfigureTarget(null);
                  setActionError(null);
                }}
              >
                {t('Cancel')}
              </Button>
              <Button
                type="submit"
                form="domain-configuration-form"
                loading={outboundMutation.isPending}
                disabled={
                  connectionsQuery.isPending ||
                  connectionsQuery.isError ||
                  outboundMutation.isPending ||
                  verifyMutation.isPending ||
                  connectionId === (configureTarget.outboundConnectionId ?? '')
                }
              >
                {t('Save')}
              </Button>
            </div>
          </div>
        ) : null}
      </EditorDialog>
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
