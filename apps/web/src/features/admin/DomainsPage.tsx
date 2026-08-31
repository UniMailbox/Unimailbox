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
import {
  adminDomainsQuery,
  adminQueryKeys,
  createManagedDomain,
  deleteManagedDomain,
  verifyManagedDomain,
} from './admin-queries';

export function DomainsPage(): ReactElement {
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (sessionQuery.data === null) {
    return <Unauthorized variant="expired" />;
  }
  return <DomainsContent />;
}

function DomainsContent(): ReactElement {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const query = adminDomainsQuery();
  const [name, setName] = useState('');
  const [addError, setAddError] = useState<ApiError | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedDomain | null>(null);
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
      setNotice(`Added ${domain.name}.`);
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
      setNotice(`Operator confirmation recorded for ${result.domain}.`);
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
      setNotice('Domain deleted.');
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
        <p>Loading…</p>
      </main>
    );
  }
  if (queryError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read managed domains."
        >
          <p>Ask an administrator if you need access to this area.</p>
        </Card>
      </main>
    );
  }
  if (!hasData && queryError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <header className="admin-header">
          <h1>Domains</h1>
        </header>
        <Card title="Could not load domains" description="Managed domains are unavailable.">
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
  return (
    <main className="admin-page" data-testid="admin-domains-page">
      <header className="admin-header">
        <h1>Domains</h1>
      </header>
      <Card
        title="Managed domains"
        description="Add domains that this deployment owns for mailbox addresses."
      >
        <p data-testid="domain-verify-note">
          Verify records an operator confirmation only; it does not call Cloudflare or test email
          delivery.
        </p>
        <form onSubmit={submitAdd} className="admin-form" noValidate>
          <label htmlFor="managed-domain-name">Domain name</label>
          <div className="admin-form-row">
            <input
              id="managed-domain-name"
              ref={domainNameInputRef}
              name="name"
              type="text"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-describedby={addError === null ? undefined : 'domain-add-error'}
            />
            <Button type="submit" disabled={addMutation.isPending}>
              {addMutation.isPending ? 'Adding…' : 'Add domain'}
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
            <span>Could not refresh domains: {queryError.message}</span>{' '}
            <span>{queryError.code}</span>
            <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {domains.length === 0 ? (
          <p data-testid="admin-domains-empty">No managed domains exist yet.</p>
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
                    {domain.status}
                  </span>
                  <small>Updated {domain.updatedAt}</small>
                </div>
                <div className="admin-domain-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => verifyMutation.mutate(domain.id)}
                    disabled={verifyMutation.isPending || deleteMutation.isPending}
                    aria-label={`Verify ${domain.name}`}
                  >
                    {verifyMutation.isPending ? 'Verifying…' : 'Verify'}
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => setDeleteTarget(domain)}
                    disabled={deleteMutation.isPending || verifyMutation.isPending}
                    aria-label={`Delete ${domain.name}`}
                  >
                    Delete
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
        title="Delete this managed domain?"
        confirmLabel={deleteMutation.isPending ? 'Deleting…' : 'Delete domain'}
        confirmDisabled={deleteMutation.isPending}
        error={actionError === null ? undefined : `${actionError.message} (${actionError.code})`}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget.id);
        }}
      >
        <p>This cannot be undone. Domains that still have mailboxes cannot be deleted.</p>
      </AlertDialog>
    </main>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('UNKNOWN', error instanceof Error ? error.message : 'Unexpected error.', 0);
}
