// apps/web — general settings administration (CAP-069).
//
// This page renders the strict server projection as ordinary controls. It
// never renders arbitrary system_settings rows or secret material. Policy
// values are clearly labelled as stored configuration where their future
// runtime consumers belong to another capability.

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateSystemSettingsRequestSchema, type SystemSettings } from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { adminQueryKeys, adminSettingsQuery, updateAdminSettings } from './admin-queries';

export function SettingsPage(): ReactElement {
  const sessionQuery = authSessionQuery();
  if (sessionQuery.data === undefined) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (sessionQuery.data === null) return <Unauthorized variant="expired" />;
  return <SettingsContent />;
}

function SettingsContent(): ReactElement {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const session = authSessionQuery().data;
  const query = adminSettingsQuery();
  const userId = session?.userId ?? 'anonymous';
  const settingsKey = adminQueryKeys.settings(userId);
  const [form, setForm] = useState<SystemSettings | null>(null);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isRefreshingAfterConflict, setIsRefreshingAfterConflict] = useState(false);
  const [refreshError, setRefreshError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (query.data !== undefined) setForm(query.data.settings);
  }, [query.data]);

  const refreshAfterConflict = (): void => {
    setIsRefreshingAfterConflict(true);
    setRefreshError(null);
    void query
      .refetch({ throwOnError: true })
      .then((result) => {
        if (result.isError) throw result.error;
        if (result.data === undefined) {
          throw new ApiError('INVALID_RESPONSE', 'Unexpected response from the server.', 0);
        }
        setForm(result.data.settings);
        queryClient.setQueryData(settingsKey, result.data);
        setRefreshError(null);
        setIsRefreshingAfterConflict(false);
      })
      .catch((error: unknown) => {
        setRefreshError(normalizeApiError(error));
        // Keep the form disabled while the query retains its old data. The
        // retry action below is the only way to re-enable editing after a
        // successful refresh.
      });
  };

  const updateMutation = useMutation({
    mutationFn: (request: SystemSettings) =>
      updateAdminSettings(apiClient, request, query.data?.updatedAt ?? ''),
    onMutate: () => {
      setFormError(null);
      setNotice(null);
    },
    onSuccess: (result) => {
      setForm(result.settings);
      queryClient.setQueryData(settingsKey, result);
      setNotice('General settings saved.');
    },
    onError: (error) => {
      const apiError = normalizeApiError(error);
      setFormError(apiError);
      if (apiError.code === 'STALE_IF_MATCH') {
        refreshAfterConflict();
      }
    },
  });

  const queryError = query.error === null ? null : normalizeApiError(query.error);
  const hasData = query.data !== undefined;
  if (queryError?.code === 'PERMISSION_DENIED') {
    return (
      <main className="admin-page" data-testid="admin-not-authorized" role="status">
        <Card
          title="Administrator access required"
          description="Your account does not have permission to read general settings."
        >
          <p>Ask an administrator if you need access to this area.</p>
        </Card>
      </main>
    );
  }
  if (!hasData && query.isPending) {
    return (
      <main className="admin-page" data-testid="admin-loading">
        <p>Loading…</p>
      </main>
    );
  }
  if (!hasData && queryError !== null) {
    return (
      <main className="admin-page" data-testid="admin-error">
        <header className="admin-header">
          <h1>General settings</h1>
        </header>
        <Card title="Could not load settings" description="General settings are unavailable.">
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
  if (form === null || query.data === undefined) {
    return <main className="admin-page" data-testid="admin-loading" />;
  }

  const canManage = query.data.canManage;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsed = updateSystemSettingsRequestSchema.safeParse(form);
    if (!parsed.success) {
      setFormError(new ApiError('VALIDATION_ERROR', 'Enter valid settings values.', 400));
      return;
    }
    updateMutation.mutate(parsed.data);
  };

  return (
    <main className="admin-page" data-testid="admin-settings-page">
      <header className="admin-header">
        <h1>General settings</h1>
      </header>
      <Card
        title="Deployment settings"
        description="Manage the typed system policy stored for this UniMailbox deployment."
      >
        <p data-testid="settings-policy-note">
          These values are stored deployment policy. Runtime enforcement and retention cleanup are
          adopted by their owning capabilities; this page does not expose provider credentials.
        </p>
        <dl className="admin-settings-runtime" data-testid="settings-runtime-info">
          <div>
            <dt>Environment</dt>
            <dd>{query.data.environment}</dd>
          </div>
          <div>
            <dt>Last saved</dt>
            <dd>{query.data.updatedAt}</dd>
          </div>
        </dl>
        {!canManage ? (
          <p role="status" data-testid="settings-read-only-note">
            You have read access only. Ask an administrator to change these values.
          </p>
        ) : null}
        <form onSubmit={submit} className="admin-form" noValidate data-testid="settings-form">
          <fieldset disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}>
            <legend>General</legend>
            <label htmlFor="settings-site-title">Site title</label>
            <input
              id="settings-site-title"
              type="text"
              value={form.siteTitle}
              onChange={(event) => setForm({ ...form, siteTitle: event.target.value })}
              maxLength={100}
            />
            <label className="admin-checkbox-label">
              <input
                type="checkbox"
                checked={form.registrationEnabled}
                onChange={(event) =>
                  setForm({ ...form, registrationEnabled: event.target.checked })
                }
              />
              Allow public registration
            </label>
          </fieldset>

          <fieldset disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}>
            <legend>Mail flow policy</legend>
            <label className="admin-checkbox-label">
              <input
                type="checkbox"
                checked={form.inboundEnabled}
                onChange={(event) => setForm({ ...form, inboundEnabled: event.target.checked })}
              />
              Inbound mail enabled
            </label>
            <label className="admin-checkbox-label">
              <input
                type="checkbox"
                checked={form.outboundEnabled}
                onChange={(event) => setForm({ ...form, outboundEnabled: event.target.checked })}
              />
              Outbound mail enabled
            </label>
            <label htmlFor="settings-unknown-recipient">Unknown recipient policy</label>
            <select
              id="settings-unknown-recipient"
              value={form.unknownRecipientPolicy}
              onChange={(event) =>
                setForm({
                  ...form,
                  unknownRecipientPolicy: event.target
                    .value as SystemSettings['unknownRecipientPolicy'],
                })
              }
            >
              <option value="reject">Reject unknown recipients</option>
              <option value="store">Store unknown recipients</option>
            </select>
          </fieldset>

          <fieldset disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}>
            <legend>Limits</legend>
            <label htmlFor="settings-max-mailboxes">Maximum mailboxes per user</label>
            <input
              id="settings-max-mailboxes"
              type="number"
              min={1}
              max={100}
              value={form.maxMailboxesPerUser}
              onChange={(event) =>
                setForm({ ...form, maxMailboxesPerUser: Number(event.target.value) })
              }
            />
            <label htmlFor="settings-max-attachments">Maximum attachments per message</label>
            <input
              id="settings-max-attachments"
              type="number"
              min={1}
              max={10}
              value={form.maxAttachmentsPerMessage}
              onChange={(event) =>
                setForm({ ...form, maxAttachmentsPerMessage: Number(event.target.value) })
              }
            />
            <label htmlFor="settings-max-attachment-bytes">Maximum attachment size in bytes</label>
            <input
              id="settings-max-attachment-bytes"
              type="number"
              min={1}
              max={64 * 1024 * 1024}
              value={form.maxAttachmentBytes}
              onChange={(event) =>
                setForm({ ...form, maxAttachmentBytes: Number(event.target.value) })
              }
            />
          </fieldset>

          <fieldset disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}>
            <legend>Retention policy</legend>
            <p>Stored policy for the future Phase 4 maintenance jobs.</p>
            <label htmlFor="settings-audit-retention">Audit retention in days</label>
            <input
              id="settings-audit-retention"
              type="number"
              min={1}
              max={3650}
              value={form.auditRetentionDays}
              onChange={(event) =>
                setForm({ ...form, auditRetentionDays: Number(event.target.value) })
              }
            />
            <label htmlFor="settings-idempotency-retention">Idempotency retention in hours</label>
            <input
              id="settings-idempotency-retention"
              type="number"
              min={1}
              max={168}
              value={form.idempotencyRetentionHours}
              onChange={(event) =>
                setForm({ ...form, idempotencyRetentionHours: Number(event.target.value) })
              }
            />
          </fieldset>

          {formError !== null ? (
            <div className="admin-error-banner" role="alert" data-testid="settings-form-error">
              {formError.message} ({formError.code})
            </div>
          ) : null}
          {canManage ? (
            <Button type="submit" disabled={updateMutation.isPending || isRefreshingAfterConflict}>
              {isRefreshingAfterConflict
                ? 'Refreshing…'
                : updateMutation.isPending
                  ? 'Saving…'
                  : 'Save settings'}
            </Button>
          ) : null}
        </form>
        {isRefreshingAfterConflict ? (
          <p role="status" data-testid="settings-refreshing">
            Settings changed elsewhere. Loading the latest values…
            {refreshError !== null || queryError !== null ? (
              <Button type="button" variant="secondary" onClick={refreshAfterConflict}>
                Retry loading latest settings
              </Button>
            ) : null}
          </p>
        ) : null}
        {notice !== null ? (
          <p className="admin-success" role="status" data-testid="settings-success">
            {notice}
          </p>
        ) : null}
        {queryError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="settings-query-error">
            Could not refresh settings: {queryError.message} ({queryError.code})
            <Button
              type="button"
              variant="secondary"
              onClick={
                isRefreshingAfterConflict ? refreshAfterConflict : () => void query.refetch()
              }
            >
              Retry
            </Button>
          </div>
        ) : null}
      </Card>
    </main>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('INTERNAL', 'Something went wrong.', 500);
}
