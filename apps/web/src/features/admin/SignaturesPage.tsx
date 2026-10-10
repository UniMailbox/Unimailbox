import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { RichTextEditor, textToHtml } from '../../components/editor/RichTextEditor';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Badge } from '../../components/ui/shadcn/badge';
import { Label } from '../../components/ui/shadcn/label';
import { Switch } from '../../components/ui/shadcn/switch';
import { SelectField } from '../../components/ui/SelectField';
import { Textarea } from '../../components/ui/shadcn/textarea';
import { PageHeader } from '../../components/ui/PageHeader';
// apps/web — per-domain signature administration (CAP-068).
// Rich content uses the shared editor. The Worker remains the authority for
// sanitization and signature.manage authorization.

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
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (sessionQuery.data === null) return <Unauthorized variant="expired" />;
  return <SignaturesContent />;
}

function SignaturesContent(): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const signaturesQuery = adminSignaturesQuery();
  const domainsQuery = adminDomainsQuery();
  const userId = session?.userId ?? 'anonymous';
  const signaturesKey = adminQueryKeys.signatures(userId);
  const [domainId, setDomainId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
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
      setCreateOpen(false);
      setDomainId('');
      setHtmlContent('');
      setTextContent('');
      setIsEnabled(true);
      setNotice(t('Created the signature for {value0}.', { value0: signature.domainName }));
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
        <ContentSkeleton variant="list" />
      </main>
    );
  }
  if (signaturesError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title={t('Administrator access required')}
          description={t('Your account does not have permission to read signatures.')}
        >
          <p>{t('Ask an administrator if you need access to this area.')}</p>
        </Card>
      </main>
    );
  }
  if (!hasData && signaturesError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <PageHeader title={t('Signatures')} />
        <Card
          title={t('Could not load signatures')}
          description={t('Domain signatures are unavailable.')}
        >
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
    if (uploading) return;
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
      <PageHeader
        title={t('Signatures')}
        actions={
          availableDomains.length > 0 ? (
            <Button
              onClick={() => {
                setCreateError(null);
                setCreateOpen(true);
              }}
            >
              {t('New signature')}
            </Button>
          ) : undefined
        }
      />
      <Card
        title={t('Domain signatures')}
        description={t(
          'Configure the signature stored for each managed domain. HTML is sanitized when saved.',
        )}
      >
        <p className="configuration-note" data-testid="signature-safety-note">
          {t('Enabled signatures are added automatically to outgoing mail from this domain.')}
        </p>
        {domainsError !== null && domainsError.code !== 'PERMISSION_DENIED' ? (
          <div className="admin-error-banner" role="alert" data-testid="signatures-domain-error">
            {t('Could not load domains: ')}
            {domainsError.message} ({domainsError.code})
          </div>
        ) : null}
        {availableDomains.length > 0 ? (
          <EditorDialog
            open={createOpen}
            onOpenChange={(open) => {
              if (!createMutation.isPending && !uploading) setCreateOpen(open);
            }}
            title={t('New signature')}
            description={t('Choose a domain and add your signature content.')}
          >
            <form
              onSubmit={submitCreate}
              className="admin-form"
              noValidate
              data-testid="signature-create-form"
            >
              <label htmlFor="signature-domain">{t('Managed domain')}</label>
              <SelectField
                id="signature-domain"
                disabled={uploading || createMutation.isPending}
                value={domainId}
                onValueChange={setDomainId}
                options={[
                  { value: '', label: 'Choose a domain' },
                  ...availableDomains.map((domain) => ({ value: domain.id, label: domain.name })),
                ]}
              />
              <SignatureFields
                htmlContent={htmlContent}
                textContent={textContent}
                isEnabled={isEnabled}
                onHtmlChange={setHtmlContent}
                onTextChange={setTextContent}
                onEnabledChange={setIsEnabled}
                prefix="create"
                domainId={domainId}
                onBusyChange={setUploading}
                disabled={createMutation.isPending || uploading}
              />
              {createError !== null ? (
                <div
                  className="admin-error-banner"
                  role="alert"
                  data-testid="signature-create-error"
                >
                  {createError.message} ({createError.code})
                </div>
              ) : null}
              <Button
                type="submit"
                loading={createMutation.isPending}
                disabled={createMutation.isPending || uploading}
              >
                {createMutation.isPending ? t('Saving…') : t('Add signature')}
              </Button>
            </form>
          </EditorDialog>
        ) : null}
        {notice !== null ? (
          <p className="admin-success" role="status" data-testid="signature-success">
            {notice}
          </p>
        ) : null}
        {signaturesQuery.error !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="signatures-query-error">
            {t('Could not refresh signatures: ')}
            {signaturesError?.message} ({signaturesError?.code})
            <Button
              type="button"
              variant="secondary"
              onClick={() => void signaturesQuery.refetch()}
            >
              {t('Retry')}
            </Button>
          </div>
        ) : null}
        {signatures.length === 0 ? (
          <p data-testid="admin-signatures-empty">{t('No domain signatures exist yet.')}</p>
        ) : (
          <ul className="admin-signature-list" data-testid="admin-signatures-list">
            {signatures.map((signature) => (
              <SignatureRow
                key={signature.id}
                signature={signature}
                signaturesKey={signaturesKey}
                onNotice={setNotice}
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
  onNotice,
}: {
  readonly signature: Signature;
  readonly signaturesKey: readonly unknown[];
  readonly onNotice: (message: string) => void;
}): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const [htmlContent, setHtmlContent] = useState(signature.htmlContent);
  const [textContent, setTextContent] = useState(signature.textContent);
  const [isEnabled, setIsEnabled] = useState(signature.isEnabled);
  const [error, setError] = useState<ApiError | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editingVersion, setEditingVersion] = useState(signature.updatedAt);
  const updateMutation = useMutation({
    mutationFn: () =>
      updateAdminSignature(
        apiClient,
        signature.id,
        { htmlContent, textContent, isEnabled },
        editingVersion,
      ),
    onMutate: () => setError(null),
    onSuccess: async (updated) => {
      setEditing(false);
      onNotice(t('Saved the signature for {value0}.', { value0: signature.domainName }));
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
      onNotice(t('Deleted the signature for {value0}.', { value0: signature.domainName }));
    },
    onError: (mutationError) => setError(normalizeApiError(mutationError)),
  });

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (uploading) return;
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
      <div className="resource-row-header">
        <div>
          <strong>{signature.domainName}</strong>
          <Badge variant={signature.isEnabled ? 'secondary' : 'outline'}>
            {signature.isEnabled ? t('Enabled') : t('Disabled')}
          </Badge>
        </div>
        <div className="resource-row-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setHtmlContent(signature.htmlContent);
              setTextContent(signature.textContent);
              setIsEnabled(signature.isEnabled);
              setEditingVersion(signature.updatedAt);
              setError(null);
              setEditing(true);
            }}
            aria-label={t('Edit {value0} signature', { value0: signature.domainName })}
          >
            {t('Edit')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={updateMutation.isPending || deleteMutation.isPending || uploading}
            onClick={() => setDeleteOpen(true)}
          >
            {t('Delete')}
          </Button>
        </div>
      </div>
      <p className="signature-text-preview">{signature.textContent || 'HTML signature'}</p>
      <EditorDialog
        open={editing}
        onOpenChange={(open) => {
          if (updateMutation.isPending || uploading) return;
          if (!open) {
            setHtmlContent(signature.htmlContent);
            setTextContent(signature.textContent);
            setIsEnabled(signature.isEnabled);
            setError(null);
          }
          setEditing(open);
        }}
        title={t('Edit {value0} signature', { value0: signature.domainName })}
        description={t('Update the signature content and enabled status.')}
      >
        <form onSubmit={submit} className="admin-form" noValidate>
          <SignatureFields
            htmlContent={htmlContent}
            textContent={textContent}
            isEnabled={isEnabled}
            onHtmlChange={setHtmlContent}
            onTextChange={setTextContent}
            onEnabledChange={setIsEnabled}
            prefix={signature.id}
            domainId={signature.domainId}
            onBusyChange={setUploading}
            disabled={updateMutation.isPending || uploading}
          />
          {error !== null ? (
            <div className="admin-error-banner" role="alert">
              {error.message} ({error.code})
            </div>
          ) : null}
          <div className="admin-domain-actions">
            <Button
              type="submit"
              loading={updateMutation.isPending}
              disabled={updateMutation.isPending || deleteMutation.isPending || uploading}
            >
              {updateMutation.isPending ? t('Saving…') : t('Save signature')}
            </Button>
          </div>
        </form>
      </EditorDialog>
      <AlertDialog
        open={deleteOpen}
        name={t('Delete {value0} signature', { value0: signature.domainName })}
        title={t('Delete this signature?')}
        confirmLabel={deleteMutation.isPending ? t('Deleting…') : t('Delete signature')}
        confirmDisabled={deleteMutation.isPending}
        confirmBusy={deleteMutation.isPending}
        error={error === null ? undefined : `${error.message} (${error.code})`}
        onCancel={() => {
          if (!deleteMutation.isPending) setDeleteOpen(false);
        }}
        onConfirm={() => deleteMutation.mutate()}
      >
        <p>{t('Future messages for this domain will not use a domain signature.')}</p>
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
  domainId,
  onBusyChange,
  disabled,
}: {
  readonly htmlContent: string;
  readonly textContent: string;
  readonly isEnabled: boolean;
  readonly onHtmlChange: (value: string) => void;
  readonly onTextChange: (value: string) => void;
  readonly onEnabledChange: (value: boolean) => void;
  readonly prefix: string;
  readonly domainId: string;
  readonly onBusyChange: (busy: boolean) => void;
  readonly disabled: boolean;
}): ReactElement {
  const t = useT();
  return (
    <div className="signature-fields">
      <RichTextEditor
        key={domainId}
        id={`signature-html-${prefix}`}
        label={t('Signature')}
        value={htmlContent || textToHtml(textContent)}
        onChange={(html, text) => {
          onHtmlChange(html);
          onTextChange(text);
        }}
        scope={{ domainId }}
        onBusyChange={onBusyChange}
        disabled={disabled}
      />
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t('Plain-text alternative')}
        </summary>
        <div className="wizard-field mt-2">
          <Label htmlFor={`signature-text-${prefix}`}>{t('Plain-text content')}</Label>
          <Textarea
            id={`signature-text-${prefix}`}
            value={textContent}
            disabled={disabled}
            onChange={(event) => onTextChange(event.target.value)}
            rows={3}
          />
        </div>
      </details>
      <div className="configuration-toggle">
        <Label htmlFor={`signature-enabled-${prefix}`}>{t('Enabled')}</Label>
        <Switch
          id={`signature-enabled-${prefix}`}
          checked={isEnabled}
          onCheckedChange={onEnabledChange}
        />
      </div>
    </div>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError('UNKNOWN', error instanceof Error ? error.message : 'Unexpected error.', 0);
}
