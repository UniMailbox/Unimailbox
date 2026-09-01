// apps/web — per-domain signature administration (CAP-068).
// The form treats HTML as source text and never renders it. The Worker is the
// authority for sanitization and signature.manage authorization.

import { useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createSignatureRequestSchema,
  updateSignatureRequestSchema,
  type Signature,
} from '@unimailbox/contracts';
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
  adminSignaturesQuery,
  createAdminSignature,
  deleteAdminSignature,
  updateAdminSignature,
} from './admin-queries';

export function SignaturesPage(): ReactElement {
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (sessionQuery.data === null) return <Unauthorized variant="expired" />;
  return <SignaturesContent />;
}

function SignaturesContent(): ReactElement {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const signaturesQuery = adminSignaturesQuery();
  const domainsQuery = adminDomainsQuery();
  const userId = session?.userId ?? 'anonymous';
  const signaturesKey = adminQueryKeys.signatures(userId);
  const [domainId, setDomainId] = useState('');
  const [htmlContent, setHtmlContent] = useState('');
  const [textContent, setTextContent] = useState('');
  const [isEnabled, setIsEnabled] = useState(true);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: () =>
      createAdminSignature(apiClient, { domainId, htmlContent, textContent, isEnabled }),
    onMutate: () => {
      setCreateError(null);
      setNotice(null);
    },
    onSuccess: async (signature) => {
      await queryClient.cancelQueries({ queryKey: signaturesKey });
      queryClient.setQueryData<Signature[]>(signaturesKey, (current) =>
        [...(current ?? []), signature].sort((left, right) =>
          left.domainName.localeCompare(right.domainName),
        ),
      );
      setDomainId('');
      setHtmlContent('');
      setTextContent('');
      setIsEnabled(true);
      setNotice(`Created the signature for ${signature.domainName}.`);
      void queryClient.invalidateQueries({ queryKey: signaturesKey, refetchType: 'none' });
    },
    onError: (error) => setCreateError(normalizeApiError(error)),
  });

  const signaturesError =
    signaturesQuery.error === null ? null : normalizeApiError(signaturesQuery.error);
  const domainsError = domainsQuery.error === null ? null : normalizeApiError(domainsQuery.error);
  const hasData = signaturesQuery.data !== undefined;
  if (!hasData && signaturesQuery.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (signaturesError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read signatures."
        >
          <p>Ask an administrator if you need access to this area.</p>
        </Card>
      </main>
    );
  }
  if (!hasData && signaturesError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <header className="admin-header">
          <h1>Signatures</h1>
        </header>
        <Card title="Could not load signatures" description="Domain signatures are unavailable.">
          <ErrorPanel
            message={signaturesError.message}
            code={signaturesError.code}
            onRetry={() => void signaturesQuery.refetch()}
            testId="admin-error-panel"
          />
        </Card>
      </main>
    );
  }

  const signatures = signaturesQuery.data ?? [];
  const domains = domainsQuery.data ?? [];
  const signatureDomainIds = new Set(signatures.map((signature) => signature.domainId));
  const availableDomains = domains.filter((domain) => !signatureDomainIds.has(domain.id));

  const submitCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = createSignatureRequestSchema.safeParse({
      domainId,
      htmlContent,
      textContent,
      isEnabled,
    });
    if (!parsed.success) {
      setCreateError(new ApiError('VALIDATION_ERROR', 'Enter text or HTML content.', 400));
      return;
    }
    createMutation.mutate();
  };

  return (
    <main className="admin-page" data-testid="admin-signatures-page">
      <header className="admin-header">
        <h1>Signatures</h1>
      </header>
      <Card
        title="Domain signatures"
        description="Configure the signature stored for each managed domain. HTML is sanitized when saved."
      >
        <p data-testid="signature-safety-note">
          HTML is stored as source text and is not previewed in the browser. Only safe formatting is
          retained by the server.
        </p>
        {domainsError !== null && domainsError.code !== 'PERMISSION_DENIED' ? (
          <div className="admin-error-banner" role="alert" data-testid="signatures-domain-error">
            Could not load domains: {domainsError.message} ({domainsError.code})
          </div>
        ) : null}
        {availableDomains.length > 0 ? (
          <form
            onSubmit={submitCreate}
            className="admin-form"
            noValidate
            data-testid="signature-create-form"
          >
            <h3>Add signature</h3>
            <label htmlFor="signature-domain">Managed domain</label>
            <select
              id="signature-domain"
              value={domainId}
              onChange={(event) => setDomainId(event.target.value)}
            >
              <option value="">Choose a domain</option>
              {availableDomains.map((domain) => (
                <option key={domain.id} value={domain.id}>
                  {domain.name}
                </option>
              ))}
            </select>
            <SignatureFields
              htmlContent={htmlContent}
              textContent={textContent}
              isEnabled={isEnabled}
              onHtmlChange={setHtmlContent}
              onTextChange={setTextContent}
              onEnabledChange={setIsEnabled}
              prefix="create"
            />
            {createError !== null ? (
              <div className="admin-error-banner" role="alert" data-testid="signature-create-error">
                {createError.message} ({createError.code})
              </div>
            ) : null}
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Saving…' : 'Add signature'}
            </Button>
          </form>
        ) : null}
        {notice !== null ? (
          <p className="admin-success" role="status" data-testid="signature-success">
            {notice}
          </p>
        ) : null}
        {signaturesQuery.error !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="signatures-query-error">
            Could not refresh signatures: {signaturesError?.message} ({signaturesError?.code})
            <Button
              type="button"
              variant="secondary"
              onClick={() => void signaturesQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {signatures.length === 0 ? (
          <p data-testid="admin-signatures-empty">No domain signatures exist yet.</p>
        ) : (
          <ul className="admin-signature-list" data-testid="admin-signatures-list">
            {signatures.map((signature) => (
              <SignatureRow
                key={signature.id}
                signature={signature}
                signaturesKey={signaturesKey}
              />
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}

function SignatureRow({
  signature,
  signaturesKey,
}: {
  readonly signature: Signature;
  readonly signaturesKey: readonly unknown[];
}): ReactElement {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const [htmlContent, setHtmlContent] = useState(signature.htmlContent);
  const [textContent, setTextContent] = useState(signature.textContent);
  const [isEnabled, setIsEnabled] = useState(signature.isEnabled);
  const [error, setError] = useState<ApiError | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const updateMutation = useMutation({
    mutationFn: () =>
      updateAdminSignature(
        apiClient,
        signature.id,
        { htmlContent, textContent, isEnabled },
        signature.updatedAt,
      ),
    onMutate: () => setError(null),
    onSuccess: async (updated) => {
      setHtmlContent(updated.htmlContent);
      setTextContent(updated.textContent);
      setIsEnabled(updated.isEnabled);
      await queryClient.cancelQueries({ queryKey: signaturesKey });
      queryClient.setQueryData<Signature[]>(signaturesKey, (current) =>
        (current ?? []).map((item) => (item.id === updated.id ? updated : item)),
      );
    },
    onError: (mutationError) => setError(normalizeApiError(mutationError)),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminSignature(apiClient, signature.id),
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: signaturesKey });
      queryClient.setQueryData<Signature[]>(signaturesKey, (current) =>
        (current ?? []).filter((item) => item.id !== signature.id),
      );
      setDeleteOpen(false);
    },
    onError: (mutationError) => setError(normalizeApiError(mutationError)),
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!updateSignatureRequestSchema.safeParse({ htmlContent, textContent, isEnabled }).success) {
      setError(new ApiError('VALIDATION_ERROR', 'Enter text or HTML content.', 400));
      return;
    }
    updateMutation.mutate();
  };

  return (
    <li
      className="admin-signature-row"
      data-testid="admin-signature-row"
      data-signature-id={signature.id}
    >
      <form onSubmit={submit} className="admin-form" noValidate>
        <h3>{signature.domainName}</h3>
        <SignatureFields
          htmlContent={htmlContent}
          textContent={textContent}
          isEnabled={isEnabled}
          onHtmlChange={setHtmlContent}
          onTextChange={setTextContent}
          onEnabledChange={setIsEnabled}
          prefix={signature.id}
        />
        {error !== null ? (
          <div className="admin-error-banner" role="alert">
            {error.message} ({error.code})
          </div>
        ) : null}
        <div className="admin-domain-actions">
          <Button type="submit" disabled={updateMutation.isPending || deleteMutation.isPending}>
            {updateMutation.isPending ? 'Saving…' : 'Save signature'}
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={updateMutation.isPending || deleteMutation.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </form>
      <AlertDialog
        open={deleteOpen}
        name={`Delete ${signature.domainName} signature`}
        title="Delete this signature?"
        confirmLabel={deleteMutation.isPending ? 'Deleting…' : 'Delete signature'}
        confirmDisabled={deleteMutation.isPending}
        error={error === null ? undefined : `${error.message} (${error.code})`}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteOpen(false);
        }}
        onConfirm={() => deleteMutation.mutate()}
      >
        <p>Future messages for this domain will not use a domain signature.</p>
      </AlertDialog>
    </li>
  );
}

function SignatureFields({
  htmlContent,
  textContent,
  isEnabled,
  onHtmlChange,
  onTextChange,
  onEnabledChange,
  prefix,
}: {
  readonly htmlContent: string;
  readonly textContent: string;
  readonly isEnabled: boolean;
  readonly onHtmlChange: (value: string) => void;
  readonly onTextChange: (value: string) => void;
  readonly onEnabledChange: (value: boolean) => void;
  readonly prefix: string;
}): ReactElement {
  return (
    <>
      <label htmlFor={`signature-html-${prefix}`}>HTML content</label>
      <textarea
        id={`signature-html-${prefix}`}
        value={htmlContent}
        onChange={(event) => onHtmlChange(event.target.value)}
        rows={4}
      />
      <label htmlFor={`signature-text-${prefix}`}>Plain-text content</label>
      <textarea
        id={`signature-text-${prefix}`}
        value={textContent}
        onChange={(event) => onTextChange(event.target.value)}
        rows={4}
      />
      <label>
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />{' '}
        Enabled
      </label>
    </>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('UNKNOWN', error instanceof Error ? error.message : 'Unexpected error.', 0);
}
