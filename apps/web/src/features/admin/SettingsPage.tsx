import { ConfigurationSection } from '../../components/ui/ConfigurationSection';
import { Input } from '../../components/ui/Input';
import { Label } from '../../components/ui/shadcn/label';
import { Switch } from '../../components/ui/shadcn/switch';
import { Checkbox } from '../../components/ui/shadcn/checkbox';
import { SelectField } from '../../components/ui/SelectField';
import { PageHeader } from '../../components/ui/PageHeader';
// apps/web — general settings administration (CAP-069).
//
// This page renders the strict server projection as ordinary controls. It
// never renders arbitrary system_settings rows or secret material. Policy
// values are clearly labelled as stored configuration where their future
// runtime consumers belong to another capability.

import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES,
  updateSystemSettingsRequestSchema,
  type SystemSettings,
} from '@unimailbox/contracts';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { ApiError } from '../../infrastructure/api/errors';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ErrorPanel } from '../../components/ui/ErrorPanel';
import { LocalDateTime } from '../../components/ui/LocalDateTime';
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
        <PageHeader
          title="General settings"
          description="Configure preferences for this deployment."
        />
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
      <PageHeader
        title="General settings"
        description="Configure preferences for this deployment."
      />
      <div className="settings-metadata" data-testid="settings-runtime-info">
        <span>
          Environment: <strong>{query.data.environment}</strong>
        </span>
        <span>
          Last saved:{' '}
          {query.data.updatedAt.startsWith('1970-01-01') ? (
            'Not saved yet'
          ) : (
            <LocalDateTime value={query.data.updatedAt} />
          )}
        </span>
      </div>
      <p className="configuration-note" data-testid="settings-policy-note">
        Stored policy. Some values are not yet enforced by runtime services.
      </p>
      {!canManage ? (
        <p role="status" data-testid="settings-read-only-note">
          Read-only access. Ask an administrator to make changes.
        </p>
      ) : null}
      <form onSubmit={submit} className="settings-form" noValidate data-testid="settings-form">
        <fieldset disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}>
          <ConfigurationSection title="General" description="Name and account access.">
            <Input
              id="settings-site-title"
              label="Site title"
              type="text"
              value={form.siteTitle}
              onChange={(event) => setForm({ ...form, siteTitle: event.target.value })}
              maxLength={100}
            />
            <div className="configuration-toggle">
              <Label htmlFor="settings-registration">
                Public registration disabled{' '}
                <span className="configuration-help">Accounts are created by administrators.</span>
              </Label>
              <Checkbox id="settings-registration" checked={false} disabled />
            </div>
          </ConfigurationSection>
          <ConfigurationSection title="Mail flow" description="Receiving and sending preferences.">
            <div className="configuration-toggle">
              <Label htmlFor="settings-inbound">Inbound mail enabled</Label>
              <Switch
                id="settings-inbound"
                checked={form.inboundEnabled}
                disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}
                onCheckedChange={(checked) => setForm({ ...form, inboundEnabled: checked })}
              />
            </div>
            <div className="configuration-toggle">
              <Label htmlFor="settings-outbound">Outbound mail enabled</Label>
              <Switch
                id="settings-outbound"
                checked={form.outboundEnabled}
                disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}
                onCheckedChange={(checked) => setForm({ ...form, outboundEnabled: checked })}
              />
            </div>
            <div className="wizard-field">
              <Label htmlFor="settings-unknown-recipient">Unknown recipient policy</Label>
              <SelectField
                id="settings-unknown-recipient"
                value={form.unknownRecipientPolicy}
                disabled={!canManage || updateMutation.isPending || isRefreshingAfterConflict}
                onValueChange={(value) =>
                  setForm({
                    ...form,
                    unknownRecipientPolicy: value as SystemSettings['unknownRecipientPolicy'],
                  })
                }
                options={[
                  { value: 'reject', label: 'Reject unknown recipients' },
                  { value: 'store', label: 'Store unknown recipients' },
                ]}
              />
            </div>
          </ConfigurationSection>
          <ConfigurationSection title="Limits" description="Mailbox and attachment limits.">
            <Input
              id="settings-max-mailboxes"
              label="Maximum mailboxes per user"
              type="number"
              min={1}
              max={100}
              value={form.maxMailboxesPerUser}
              onChange={(event) =>
                setForm({ ...form, maxMailboxesPerUser: Number(event.target.value) })
              }
            />
            <Input
              id="settings-max-attachments"
              label="Maximum attachments per message"
              type="number"
              min={1}
              max={10}
              value={form.maxAttachmentsPerMessage}
              onChange={(event) =>
                setForm({ ...form, maxAttachmentsPerMessage: Number(event.target.value) })
              }
            />
            {(() => {
              const attachment = attachmentSizeParts(form.maxAttachmentBytes);
              const factor = attachment.unit === 'MB' ? 1024 * 1024 : 1024;
              return (
                <div className="settings-attachment-size" data-testid="settings-attachment-size">
                  <Input
                    id="settings-max-attachment-value"
                    label="Maximum attachment size"
                    help="Limit applies to each message attachment."
                    type="number"
                    min={1}
                    max={Math.floor(SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES / factor)}
                    step={1}
                    value={attachment.value}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setForm({
                        ...form,
                        maxAttachmentBytes: Number.isFinite(value)
                          ? Math.min(value * factor, SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES)
                          : form.maxAttachmentBytes,
                      });
                    }}
                  />
                  <div className="settings-attachment-unit">
                    <label className="input-label" htmlFor="settings-max-attachment-unit">
                      Unit
                    </label>
                    <SelectField
                      id="settings-max-attachment-unit"
                      label="Attachment size unit"
                      value={attachment.unit}
                      onValueChange={(unit) => {
                        const nextFactor = unit === 'MB' ? 1024 * 1024 : 1024;
                        const nextValue = Math.max(
                          1,
                          Math.round(form.maxAttachmentBytes / nextFactor),
                        );
                        setForm({
                          ...form,
                          maxAttachmentBytes: Math.min(
                            nextValue * nextFactor,
                            SYSTEM_SETTINGS_MAX_ATTACHMENT_BYTES,
                          ),
                        });
                      }}
                      options={[
                        { value: 'KB', label: 'KB' },
                        { value: 'MB', label: 'MB' },
                      ]}
                    />
                  </div>
                </div>
              );
            })()}
          </ConfigurationSection>
          <ConfigurationSection
            title="Retention"
            description="Stored policy. Automatic cleanup is not active yet."
          >
            <Input
              id="settings-audit-retention"
              label="Audit retention in days"
              type="number"
              min={1}
              max={3650}
              value={form.auditRetentionDays}
              onChange={(event) =>
                setForm({ ...form, auditRetentionDays: Number(event.target.value) })
              }
            />
            <Input
              id="settings-idempotency-retention"
              label="Idempotency retention in hours"
              type="number"
              min={1}
              max={168}
              value={form.idempotencyRetentionHours}
              onChange={(event) =>
                setForm({ ...form, idempotencyRetentionHours: Number(event.target.value) })
              }
            />
          </ConfigurationSection>
        </fieldset>
        {formError !== null ? (
          <div className="admin-error-banner" role="alert" data-testid="settings-form-error">
            {formError.message} ({formError.code})
          </div>
        ) : null}
        {canManage ? (
          <div className="configuration-save-bar">
            <span className="configuration-help">Changes apply after saving.</span>
            <Button type="submit" disabled={updateMutation.isPending || isRefreshingAfterConflict}>
              {isRefreshingAfterConflict
                ? 'Refreshing…'
                : updateMutation.isPending
                  ? 'Saving…'
                  : 'Save settings'}
            </Button>
          </div>
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
            onClick={isRefreshingAfterConflict ? refreshAfterConflict : () => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </main>
  );
}

function normalizeApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError('INTERNAL', 'Something went wrong.', 500);
}

function attachmentSizeParts(bytes: number): {
  readonly value: number;
  readonly unit: 'KB' | 'MB';
} {
  const megabyte = 1024 * 1024;
  if (bytes === 0) {
    return { value: 0, unit: 'MB' };
  }
  if (bytes >= megabyte && bytes % megabyte === 0) {
    return { value: bytes / megabyte, unit: 'MB' };
  }
  return { value: Math.max(1, Math.round(bytes / 1024)), unit: 'KB' };
}
