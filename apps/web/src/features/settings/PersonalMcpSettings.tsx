import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buildMcpPrompt,
  createMcpTokenSchema,
  issuedMcpTokenSchema,
  mcpTokenPageSchema,
  type PersonalMcpSettings as PersonalSettings,
  personalMcpSettingsSchema,
} from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { errorMessage } from '../../infrastructure/i18n/error-messages';
import { useT } from '../../infrastructure/i18n/locale';
import { McpCredentialForm } from './McpCredentialForm';
import { McpCredentialList } from './McpCredentialList';

export function PersonalMcpSettings({ userId }: { userId: string | undefined }): ReactElement {
  const t = useT();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['personal-mcp', userId],
    enabled: !!userId,
    // Refresh on each opening and explicit changes, without idle KV reads.
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async () => {
      const response = (await client.fetch('/api/v1/auth/me/mcp', { retry: false })) as {
        data: unknown;
      };
      return personalMcpSettingsSchema.parse(response.data);
    },
  });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // A plaintext credential belongs only to this mounted personal dialog.
  const [secret, setSecret] = useState<string | null>(null);
  const data = query.data;
  const canReveal = useRef(false);
  canReveal.current = !!data?.enabled && editing;
  useEffect(
    () => () => {
      canReveal.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!data?.enabled) {
      setSecret(null);
      setEditing(false);
    }
  }, [data?.enabled]);
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? errorMessage(error.code)
          : t('Could not update MCP configuration.'),
      );
    } finally {
      setBusy(false);
    }
  }
  function loadMore(): void {
    const cursor = data?.nextCursor;
    if (!cursor) return;
    void run(async () => {
      const response = (await client.fetch(`/api/v1/auth/me/mcp/tokens?cursor=${cursor}`, {
        retry: false,
      })) as { data: unknown };
      const page = mcpTokenPageSchema.parse(response.data);
      queryClient.setQueryData<PersonalSettings>(['personal-mcp', userId], (current) =>
        current
          ? {
              ...current,
              tokens: [
                ...current.tokens,
                ...page.tokens.filter(
                  (token) => !current.tokens.some((old) => old.id === token.id),
                ),
              ],
              nextCursor: page.nextCursor,
            }
          : current,
      );
    });
  }
  function copy(text: string): void {
    void run(async () => {
      await navigator.clipboard.writeText(text);
      setMessage(t('Copied.'));
    });
  }
  function close(): void {
    setEditing(false);
    setSecret(null);
    setMessage('');
  }
  return (
    <section className="quick-settings-section" aria-label={t('MCP service')}>
      <div className="flex items-center justify-between gap-2">
        <h3>{t('MCP service')}</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || query.isFetching || !userId}
          onClick={() => void query.refetch()}
        >
          {t('Refresh MCP settings')}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">{t('Loading…')}</p>
      ) : query.isError ? (
        <p role="alert">
          {t('Could not load MCP configuration.')}{' '}
          <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
            {t('Retry')}
          </Button>
        </p>
      ) : null}
      {data && (data.enabled || data.tokens.length > 0) ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t(
              data.enabled
                ? 'Choose what your local AI agent can access. Read-only access is the default.'
                : 'MCP service is disabled. You can still revoke existing credentials.',
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || query.isFetching}
              onClick={() => {
                setMessage('');
                setEditing(true);
              }}
            >
              {t('Manage agent access')}
            </Button>
            {data.enabled ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || query.isFetching}
                onClick={() => copy(buildMcpPrompt(data.endpoint, data.promptTemplate))}
              >
                {t('Copy prompt')}
              </Button>
            ) : null}
          </div>
          <EditorDialog
            open={editing}
            onOpenChange={(open) => {
              if (!busy && !open) close();
            }}
            aboveCompose
            title={t('Your agent credentials')}
            description={t(
              'Credentials only grant access within your current mailbox permissions.',
            )}
          >
            <div className="space-y-6">
              <div className="rounded-md bg-muted p-3 text-sm">
                <span className="block font-medium">{t('MCP endpoint')}</span>
                <code className="break-all text-xs">{data.endpoint}</code>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(
                    'The prompt contains no credential. Set UNIMAILBOX_MCP_TOKEN privately in your local agent environment.',
                  )}
                </p>
              </div>
              {data.enabled ? (
                secret ? (
                  <div className="space-y-3 rounded-md border border-primary/40 p-4">
                    <Input
                      id="mcp-personal-secret"
                      label={t('One-time credential')}
                      type="password"
                      autoComplete="off"
                      readOnly
                      value={secret}
                      help={t(
                        'Store this credential securely. It cannot be recovered after dismissal.',
                      )}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button disabled={busy} onClick={() => copy(secret)}>
                        {t('Copy credential')}
                      </Button>
                      <Button variant="secondary" disabled={busy} onClick={() => setSecret(null)}>
                        {t('Dismiss')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <McpCredentialForm
                    mailboxes={data.mailboxes}
                    busy={busy}
                    onCreate={(request) => {
                      void run(async () => {
                        const response = (await client.fetch('/api/v1/auth/me/mcp/tokens', {
                          method: 'POST',
                          body: createMcpTokenSchema.parse(request),
                          retry: false,
                        })) as { data: unknown };
                        const issued = issuedMcpTokenSchema.parse(response.data);
                        if (canReveal.current) setSecret(issued.token);
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
                  />
                )
              ) : null}
              {message ? (
                <p role="status" className="text-sm">
                  {message}
                </p>
              ) : null}
              <McpCredentialList
                tokens={data.tokens}
                mailboxes={data.mailboxes}
                busy={busy}
                onRevoke={(id) =>
                  void run(async () => {
                    await client.fetch(`/api/v1/auth/me/mcp/tokens/${id}/revoke`, {
                      method: 'POST',
                      retry: false,
                    });
                    setSecret(null);
                    await query.refetch();
                  })
                }
              />
              {data.nextCursor ? (
                <Button variant="secondary" disabled={busy || query.isFetching} onClick={loadMore}>
                  {t('Load more credentials')}
                </Button>
              ) : null}
              <div className="admin-dialog-actions">
                {data.enabled ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => copy(buildMcpPrompt(data.endpoint, data.promptTemplate))}
                  >
                    {t('Copy prompt')}
                  </Button>
                ) : null}
                <Button disabled={busy} onClick={close}>
                  {t('Done')}
                </Button>
              </div>
            </div>
          </EditorDialog>
        </>
      ) : data ? (
        <p className="text-sm text-muted-foreground">
          {t('MCP service is disabled. Contact an administrator to enable it.')}
        </p>
      ) : null}
      {!editing && message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
