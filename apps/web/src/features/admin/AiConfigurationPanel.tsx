import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  aiConfigurationSchema,
  type AiConfiguration,
  type AiProtocol,
} from '@unimailbox/contracts';
import { useT } from '../../infrastructure/i18n/locale';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card } from '../../components/ui/Card';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { SelectField } from '../../components/ui/SelectField';
import { Label } from '../../components/ui/shadcn/label';
import { Switch } from '../../components/ui/shadcn/switch';
import { authSessionQuery } from '../auth/auth-queries';
import { aiConfigurationKey, useAiConfiguration, saveAiConfiguration } from './ai-queries';

export function AiConfigurationPanel(): ReactElement {
  const t = useT();
  const client = useApiClient();
  const query = useAiConfiguration();
  const queryClient = useQueryClient();
  const userId = authSessionQuery().data?.userId ?? 'anonymous';
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<AiConfiguration | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [enabledBeforeKeyRemoval, setEnabledBeforeKeyRemoval] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (!query.data) return;
    setForm(query.data.configuration);
    setRevision(query.data.revision);
    setApiKey('');
    setClearKey(false);
    setConflict(false);
  }, [query.data]);
  // Mutation variables contain only a marker; keep secrets out of mutation cache.
  const save = useMutation({
    mutationFn: async () => {
      if (!form) throw new Error('Missing AI form');
      return saveAiConfiguration(
        client,
        {
          configuration: aiConfigurationSchema.parse(form),
          ...(form.protocol === 'workers-ai'
            ? { apiKey: null }
            : clearKey
              ? { apiKey: null }
              : apiKey.trim()
                ? { apiKey: apiKey.trim() }
                : {}),
        },
        revision,
      );
    },
    onSuccess: (result) => {
      setApiKey('');
      setClearKey(false);
      setMessage(t('AI configuration saved.'));
      setEditing(false);
      setForm(result.configuration);
      setRevision(result.revision);
      queryClient.setQueryData(aiConfigurationKey(userId), result);
    },
    onError: (error) => {
      setMessage(
        error instanceof ApiError ? error.message : t('Enter valid AI configuration values.'),
      );
      if (error instanceof ApiError && error.code === 'STALE_IF_MATCH') setConflict(true);
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setMessage(null);
    save.mutate();
  };
  const header = (actions?: ReactElement): ReactElement => (
    <PageHeader
      title={t('AI services')}
      description={t('Configure the AI backend used to draft email replies.')}
      actions={actions}
    />
  );
  if (query.isPending)
    return (
      <>
        {header()}
        <p role="status">{t('Loading AI configuration…')}</p>
      </>
    );
  if (query.isError)
    return (
      <>
        {header()}
        <div role="alert">
          {t('Could not load AI configuration.')}{' '}
          <Button variant="secondary" onClick={() => void query.refetch()}>
            {t('Retry')}
          </Button>
        </div>
      </>
    );
  if (!form || !query.data) return <></>;
  const canManage = query.data.canManage;
  const destinationChanged =
    form.protocol !== query.data.configuration.protocol ||
    form.baseUrl !== query.data.configuration.baseUrl;
  return (
    <>
      {header(
        canManage ? (
          <Button
            onClick={() => {
              setForm(query.data.configuration);
              setRevision(query.data.revision);
              setMessage(null);
              setConflict(false);
              setEditing(true);
            }}
          >
            {t('Edit AI configuration')}
          </Button>
        ) : undefined,
      )}
      <Card>
        <dl className="admin-configuration-summary">
          {[
            [t('Enable AI service'), t(query.data.configuration.enabled ? 'Enabled' : 'Disabled')],
            [t('API protocol'), query.data.configuration.protocol],
            [t('Model ID'), query.data.configuration.model],
            [t('Service base URL'), query.data.configuration.baseUrl ?? t('Default')],
            ['API Key', t(query.data.hasApiKey ? 'Configured' : 'Not configured')],
            [t('Maximum output tokens'), query.data.configuration.maxOutputTokens],
            [t('Timeout in milliseconds'), query.data.configuration.timeoutMs],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {!canManage ? <p>{t('Read-only access. Ask an administrator to make changes.')}</p> : null}
      </Card>
      {!editing && message ? <p role="status">{message}</p> : null}
      <EditorDialog
        open={editing}
        onOpenChange={(open) => {
          if (save.isPending) return;
          setEditing(open);
          if (!open) {
            setForm(query.data.configuration);
            setRevision(query.data.revision);
            setApiKey('');
            setClearKey(false);
            setConflict(false);
            setMessage(null);
            save.reset();
          }
        }}
        title={t('Edit AI configuration')}
        description={t('Configure the AI backend used to draft email replies.')}
      >
        <form onSubmit={submit} className="settings-form" data-testid="ai-configuration-form">
          <fieldset disabled={!canManage || save.isPending || conflict}>
            <div className="configuration-toggle">
              <Label htmlFor="ai-enabled">{t('Enable AI service')}</Label>
              <Switch
                id="ai-enabled"
                checked={form.enabled}
                disabled={!canManage || save.isPending || conflict}
                onCheckedChange={(enabled) => setForm({ ...form, enabled })}
              />
            </div>
            <div className="wizard-field">
              <Label htmlFor="ai-protocol">{t('API protocol')}</Label>
              <SelectField
                id="ai-protocol"
                disabled={!canManage || save.isPending || conflict}
                value={form.protocol}
                options={[
                  { value: 'workers-ai', label: 'Cloudflare Workers AI' },
                  { value: 'anthropic', label: 'Anthropic Messages' },
                  { value: 'openai', label: 'OpenAI Chat Completions' },
                ]}
                onValueChange={(value) => {
                  setForm({ ...form, protocol: value as AiProtocol, baseUrl: null });
                  setApiKey('');
                  setClearKey(false);
                }}
              />
            </div>
            <Input
              id="ai-model"
              label={t('Model ID')}
              value={form.model}
              onChange={(event) => setForm({ ...form, model: event.target.value })}
              maxLength={200}
            />
            {form.protocol === 'workers-ai' ? (
              <p role="status">
                {query.data.workersAiAvailable
                  ? t('Workers AI binding available.')
                  : t('Workers AI binding unavailable. Add the AI binding before enabling.')}
              </p>
            ) : (
              <>
                <Input
                  id="ai-base-url"
                  label={t('Service base URL')}
                  help={t(
                    'Leave empty to use the official service. Enter an HTTPS base URL for a compatible backend.',
                  )}
                  placeholder={
                    form.protocol === 'openai'
                      ? 'https://api.openai.com/v1'
                      : 'https://api.anthropic.com'
                  }
                  value={form.baseUrl ?? ''}
                  onChange={(event) => {
                    setForm({ ...form, baseUrl: event.target.value || null });
                    setApiKey('');
                  }}
                />
                <div className="ai-api-key-field">
                  <div className="ai-api-key-heading">
                    <Label htmlFor="ai-api-key">API Key</Label>
                    {query.data.hasApiKey && !destinationChanged ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={clearKey ? undefined : 'ai-key-remove'}
                        onClick={() => {
                          if (clearKey) {
                            setClearKey(false);
                            setForm({ ...form, enabled: enabledBeforeKeyRemoval });
                          } else {
                            setEnabledBeforeKeyRemoval(form.enabled);
                            setClearKey(true);
                            setApiKey('');
                            setForm({ ...form, enabled: false });
                          }
                        }}
                      >
                        {t(clearKey ? 'Undo' : 'Remove saved API key')}
                      </Button>
                    ) : null}
                  </div>
                  <Input
                    id="ai-api-key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setClearKey(false);
                    }}
                    help={
                      !destinationChanged && query.data.hasApiKey && !clearKey
                        ? t('API key saved. Leave empty to keep it.')
                        : t('Enter an API key for this backend.')
                    }
                  />
                  {clearKey ? (
                    <p role="status">{t('API key will be removed when saved.')}</p>
                  ) : null}
                </div>
              </>
            )}
            <Input
              id="ai-max-tokens"
              label={t('Maximum output tokens')}
              type="number"
              min={1}
              max={32768}
              value={form.maxOutputTokens}
              onChange={(event) =>
                setForm({ ...form, maxOutputTokens: Number(event.target.value) })
              }
            />
            <Input
              id="ai-timeout"
              label={t('Timeout in milliseconds')}
              type="number"
              min={1000}
              max={120000}
              value={form.timeoutMs}
              onChange={(event) => setForm({ ...form, timeoutMs: Number(event.target.value) })}
            />
          </fieldset>
          {conflict ? (
            <Button type="button" variant="secondary" onClick={() => void query.refetch()}>
              {t('Reload AI configuration')}
            </Button>
          ) : null}
          {message ? <p role={save.isError ? 'alert' : 'status'}>{message}</p> : null}
          {canManage ? (
            <div className="admin-dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={save.isPending}
                onClick={() => {
                  setEditing(false);
                  setForm(query.data.configuration);
                  setRevision(query.data.revision);
                  setApiKey('');
                  setClearKey(false);
                  setConflict(false);
                  setMessage(null);
                  save.reset();
                }}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={conflict}>
                {t('Save AI configuration')}
              </Button>
            </div>
          ) : (
            <p>{t('Read-only access. Ask an administrator to make changes.')}</p>
          )}
        </form>
      </EditorDialog>
    </>
  );
}
