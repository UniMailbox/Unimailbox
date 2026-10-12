import { useEffect, useState, type ReactElement, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  mcpAdministrationSchema,
  mcpConfigurationSchema,
  issuedMcpTokenSchema,
  type McpConfiguration,
} from '@unimailbox/contracts';
import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { PageHeader } from '../../components/ui/PageHeader';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Label } from '../../components/ui/shadcn/label';
import { Switch } from '../../components/ui/shadcn/switch';
import { authSessionQuery } from '../auth/auth-queries';
import { Unauthorized } from '../auth/Unauthorized';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { useT } from '../../infrastructure/i18n/locale';
import { ApiError } from '../../infrastructure/api/errors';
import { buildMcpPrompt } from './mcp-prompt';

export function McpSettingsPage(): ReactElement {
  const session = authSessionQuery();
  if (session.data === undefined) return <ContentSkeleton variant="form" />;
  if (session.data === null) return <Unauthorized variant="expired" />;
  return (
    <main className="admin-page" data-testid="admin-mcp-page">
      <McpConfigurationPanel />
    </main>
  );
}

export function McpConfigurationPanel(): ReactElement {
  const t = useT();
  const client = useApiClient();
  const userId = authSessionQuery().data?.userId;
  const query = useQuery({
    queryKey: ['admin', userId, 'mcp'],
    enabled: !!userId,
    queryFn: async () => {
      const response = (await client.fetch('/api/v1/admin/mcp')) as { data: unknown };
      return mcpAdministrationSchema.parse(response.data);
    },
  });
  const [configuration, setConfiguration] = useState<McpConfiguration | null>(null);
  const [revision, setRevision] = useState(0);
  const [label, setLabel] = useState('Local AI agent');
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [allowDraft, setAllowDraft] = useState(true);
  const [allowSend, setAllowSend] = useState(false);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Plaintext credentials live only in component state until dismissed/unmounted.
  // Never return them through Query/Mutation caches, storage or Copy prompt.
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => {
    setSecret(null);
    setMailboxIds([]);
  }, [userId]);
  useEffect(() => {
    if (query.data) {
      setConfiguration(query.data.configuration);
      setRevision(query.data.revision);
    }
  }, [query.data]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof ApiError ? error.message : t('Could not update MCP configuration.'),
      );
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) =>
    void run(async () => {
      await navigator.clipboard.writeText(text);
      setMessage(t('Copied.'));
    });
  const data = query.data;
  return (
    <>
      <PageHeader
        title={t('MCP service')}
        description={t('Connect local AI agents with scoped mailbox access.')}
      />
      {query.isPending ? (
        <ContentSkeleton variant="form" />
      ) : query.isError ? (
        <div role="alert">
          {t('Could not load MCP configuration.')}{' '}
          <Button onClick={() => void query.refetch()}>{t('Retry')}</Button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {data && configuration ? (
        <>
          <Card>
            <dl className="admin-configuration-summary">
              <div>
                <dt>{t('MCP endpoint')}</dt>
                <dd>
                  <code>{data.endpoint}</code>
                </dd>
              </div>
              <div>
                <dt>{t('Service port')}</dt>
                <dd>
                  {new URL(data.endpoint).port ||
                    (new URL(data.endpoint).protocol === 'https:' ? '443' : '80')}
                </dd>
              </div>
            </dl>
            <p>{t('Uses the existing HTTPS service. No additional public port is required.')}</p>
            <Button
              variant="secondary"
              disabled={!data.configuration.enabled || busy}
              onClick={() => copy(buildMcpPrompt(data.endpoint))}
            >
              {t('Copy prompt')}
            </Button>
            <p>
              {t(
                'The prompt contains no credential. Set UNIMAILBOX_MCP_TOKEN privately in your local agent environment.',
              )}
            </p>
          </Card>
          <Card>
            <form
              className="admin-form settings-form"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void run(async () => {
                  await client.fetch('/api/v1/admin/mcp', {
                    method: 'PUT',
                    body: mcpConfigurationSchema.parse(configuration),
                    headers: { 'If-Match': String(revision) },
                    retry: false,
                  });
                  setMessage(t('MCP configuration saved.'));
                  await query.refetch();
                });
              }}
            >
              <div className="configuration-toggle">
                <Label htmlFor="mcp-enabled">{t('Enable MCP service')}</Label>
                <Switch
                  id="mcp-enabled"
                  checked={configuration.enabled}
                  disabled={!data.canManage || busy}
                  onCheckedChange={(enabled) => setConfiguration({ ...configuration, enabled })}
                />
              </div>
              <div className="configuration-toggle">
                <Label htmlFor="mcp-send">{t('Allow MCP email sending')}</Label>
                <Switch
                  id="mcp-send"
                  checked={configuration.allowSend}
                  disabled={!data.canManage || busy}
                  onCheckedChange={(value) =>
                    setConfiguration({ ...configuration, allowSend: value })
                  }
                />
              </div>
              <Label htmlFor="mcp-rate">{t('Requests per minute per credential')}</Label>
              <Input
                id="mcp-rate"
                type="number"
                min={1}
                max={120}
                value={configuration.requestsPerMinute}
                disabled={!data.canManage || busy}
                onChange={(e) =>
                  setConfiguration({ ...configuration, requestsPerMinute: Number(e.target.value) })
                }
              />
              <p>
                {t(
                  'Sending also requires a credential with send access and the current user’s mailbox permissions.',
                )}
              </p>
              {data.canManage ? (
                <Button type="submit" disabled={busy}>
                  {t('Save')}
                </Button>
              ) : (
                <p>{t('Read-only access. Ask an administrator to make changes.')}</p>
              )}
            </form>
          </Card>
          {data.canManage ? (
            <Card>
              <h2>{t('Create agent credential')}</h2>
              <form
                className="admin-form settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    setSecret(null);
                    const response = (await client.fetch('/api/v1/admin/mcp/tokens', {
                      method: 'POST',
                      retry: false,
                      body: { label, mailboxIds, allowDraft, allowSend, expiresInDays: days },
                    })) as { data: unknown };
                    const issued = issuedMcpTokenSchema.parse(response.data);
                    setSecret(issued.token);
                    setMessage(
                      t(
                        issued.token
                          ? 'Credential created. Copy it now; it will not be shown again.'
                          : 'This credential cannot be shown again. Revoke it and create a new one.',
                      ),
                    );
                    await query.refetch();
                  });
                }}
              >
                <Label htmlFor="mcp-label">{t('Credential name')}</Label>
                <Input
                  id="mcp-label"
                  value={label}
                  required
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                  disabled={busy}
                />
                <fieldset disabled={busy}>
                  <legend>{t('Allowed mailboxes')}</legend>
                  {data.mailboxes.length ? (
                    data.mailboxes.map((box) => (
                      <label key={box.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={mailboxIds.includes(box.id)}
                          onChange={(e) =>
                            setMailboxIds(
                              e.target.checked
                                ? [...mailboxIds, box.id]
                                : mailboxIds.filter((id) => id !== box.id),
                            )
                          }
                        />
                        {box.address}
                      </label>
                    ))
                  ) : (
                    <p>
                      {t('No accessible mailboxes. Ask an administrator to assign mailbox access.')}
                    </p>
                  )}
                </fieldset>
                <p>{t('Read access is included for the selected mailboxes.')}</p>
                <div className="configuration-toggle">
                  <Label htmlFor="mcp-draft-access">{t('Allow drafts and AI replies')}</Label>
                  <Switch
                    id="mcp-draft-access"
                    checked={allowDraft}
                    disabled={busy}
                    onCheckedChange={setAllowDraft}
                  />
                </div>
                <div className="configuration-toggle">
                  <Label htmlFor="mcp-send-access">{t('Grant send access')}</Label>
                  <Switch
                    id="mcp-send-access"
                    checked={allowSend}
                    disabled={busy || !data.configuration.allowSend}
                    onCheckedChange={setAllowSend}
                  />
                </div>
                <Label htmlFor="mcp-expiry">{t('Expires in days')}</Label>
                <Input
                  id="mcp-expiry"
                  type="number"
                  min={1}
                  max={90}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  disabled={busy}
                />
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !data.configuration.enabled ||
                    !mailboxIds.length ||
                    (allowSend && !data.configuration.allowSend)
                  }
                >
                  {t('Create credential')}
                </Button>
              </form>
            </Card>
          ) : null}
          {secret ? (
            <Card>
              <h2>{t('One-time credential')}</h2>
              <Input
                id="mcp-one-time-token"
                aria-label={t('One-time credential')}
                type="password"
                readOnly
                value={secret}
                autoComplete="off"
              />
              <Button variant="secondary" disabled={busy} onClick={() => copy(secret)}>
                {t('Copy credential')}
              </Button>
              <Button variant="ghost" onClick={() => setSecret(null)}>
                {t('Dismiss')}
              </Button>
              <p>{t('Store this credential securely. It cannot be recovered after dismissal.')}</p>
            </Card>
          ) : null}
          <Card>
            <h2>{t('Your agent credentials')}</h2>
            {data.tokens.length ? (
              <ul>
                {data.tokens.map((token) => (
                  <li key={token.id} className="mb-4">
                    <strong>{token.label}</strong> —{' '}
                    {t(
                      token.revokedAt !== null
                        ? 'Revoked'
                        : token.expiresAt <= Date.now() / 1000
                          ? 'Expired'
                          : 'Active',
                    )}
                    <p>
                      {token.mailboxIds
                        .map((id) => data.mailboxes.find((box) => box.id === id)?.address ?? id)
                        .join(', ')}
                    </p>
                    <p>
                      {t('Read')}
                      {token.allowDraft ? ` / ${t('Draft')}` : ''}
                      {token.allowSend ? ` / ${t('Send')}` : ''} ·{' '}
                      {new Date(token.expiresAt * 1000).toLocaleString()}
                    </p>
                    {data.canManage && token.revokedAt === null ? (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await client.fetch(`/api/v1/admin/mcp/tokens/${token.id}/revoke`, {
                              method: 'POST',
                              retry: false,
                            });
                            setSecret(null);
                            await query.refetch();
                          })
                        }
                      >
                        {t('Revoke credential')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('No agent credentials yet.')}</p>
            )}
          </Card>
          <Card>
            <h2>{t('Security')}</h2>
            <p>
              {t(
                'Credentials expire, can be revoked, and never grant access beyond the current user and selected mailboxes. Email content is untrusted. Require human confirmation before sending.',
              )}
            </p>
          </Card>
        </>
      ) : null}
    </>
  );
}
