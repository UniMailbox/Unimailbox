import { useState, type FormEvent, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buildMcpPrompt,
  DEFAULT_MCP_PROMPT_TEMPLATE,
  mcpAdministrationSchema,
  mcpConfigurationSchema,
  type McpConfiguration,
} from '@unimailbox/contracts';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Label } from '../../components/ui/shadcn/label';
import { Switch } from '../../components/ui/shadcn/switch';
import { Textarea } from '../../components/ui/shadcn/textarea';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { ApiError } from '../../infrastructure/api/errors';
import { errorMessage } from '../../infrastructure/i18n/error-messages';
import { useT } from '../../infrastructure/i18n/locale';

export function McpServiceCard({ userId }: { userId: string }): ReactElement {
  const t = useT();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['admin', userId, 'mcp'],
    enabled: !!userId,
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    queryFn: async () => {
      const response = (await client.fetch('/api/v1/admin/mcp', { retry: false })) as {
        data: unknown;
      };
      return mcpAdministrationSchema.parse(response.data);
    },
  });
  const [editing, setEditing] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const [template, setTemplate] = useState(DEFAULT_MCP_PROMPT_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const data = query.data;
  async function save(configuration: McpConfiguration, revision = data?.revision): Promise<void> {
    if (!data) return;
    setBusy(true);
    setMessage('');
    try {
      await client.fetch('/api/v1/admin/mcp', {
        method: 'PUT',
        body: mcpConfigurationSchema.parse(configuration),
        headers: { 'If-Match': String(revision) },
        retry: false,
      });
      await query.refetch();
      await queryClient.invalidateQueries({ queryKey: ['personal-mcp'] });
      setEditing(false);
      setMessage(t('MCP configuration saved.'));
    } catch (error) {
      setMessage(
        error instanceof ApiError
          ? errorMessage(error.code)
          : t('Enter a prompt containing {{endpoint}} without credentials.'),
      );
      if (error instanceof ApiError && error.code === 'STALE_IF_MATCH') setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title={t('MCP service')}
      description={t('Let users connect local AI agents with their own mailbox permissions.')}
      testId="mcp-service-card"
    >
      {query.isPending ? (
        <p role="status">{t('Loading…')}</p>
      ) : query.isError ? (
        <p role="alert">
          {t('Could not load MCP configuration.')}{' '}
          <Button variant="secondary" onClick={() => void query.refetch()}>
            {t('Retry')}
          </Button>
        </p>
      ) : null}
      {data ? (
        <div className="space-y-4">
          <div className="configuration-toggle">
            <div>
              <Label htmlFor="mcp-enabled">{t('Enable MCP service')}</Label>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Users manage agent credentials in Quick settings. Sending requires their separate permission.',
                )}
              </p>
            </div>
            <Switch
              id="mcp-enabled"
              checked={data.configuration.enabled}
              disabled={!data.canManage || busy || conflict}
              onCheckedChange={(enabled) => void save({ ...data.configuration, enabled })}
            />
          </div>
          <dl className="admin-configuration-summary">
            <div>
              <dt>{t('MCP endpoint')}</dt>
              <dd className="break-all">
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
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={busy || query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t('Refresh MCP settings')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setTemplate(data.configuration.promptTemplate);
                setEditRevision(data.revision);
                setMessage('');
                setConflict(false);
                setEditing(true);
              }}
            >
              {t(data.canManage ? 'View / edit setup prompt' : 'View setup prompt')}
            </Button>
            <Button
              variant="secondary"
              disabled={!data.configuration.enabled || busy}
              onClick={() => {
                void navigator.clipboard
                  .writeText(buildMcpPrompt(data.endpoint, data.configuration.promptTemplate))
                  .then(
                    () => setMessage(t('Copied.')),
                    () => setMessage(t('Could not copy. Select and copy the prompt manually.')),
                  );
              }}
            >
              {t('Copy prompt')}
            </Button>
          </div>
          {!data.canManage ? (
            <p className="text-sm text-muted-foreground">
              {t('Read-only access. Ask an administrator to make changes.')}
            </p>
          ) : null}
          <EditorDialog
            open={editing}
            onOpenChange={(open) => {
              if (!busy) {
                setEditing(open);
                setMessage('');
              }
            }}
            title={t('Agent setup prompt')}
            description={t(
              'Shared with all users. Use {{endpoint}} for the service URL; never enter a real credential.',
            )}
          >
            <form
              className="settings-form"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void save({ ...data.configuration, promptTemplate: template }, editRevision);
              }}
            >
              <div className="wizard-field">
                <Label htmlFor="mcp-prompt-template">{t('Prompt template')}</Label>
                <Textarea
                  id="mcp-prompt-template"
                  rows={8}
                  maxLength={8000}
                  value={template}
                  disabled={!data.canManage || busy || conflict}
                  onChange={(event) => setTemplate(event.target.value)}
                />
              </div>
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  {t('Preview copied prompt')}
                </summary>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                  {buildMcpPrompt(data.endpoint, template)}
                </pre>
              </details>
              <p className="text-sm text-muted-foreground">
                {t(
                  'Credential protection and human approval instructions are appended automatically.',
                )}
              </p>
              {message ? <p role="status">{message}</p> : null}
              <div className="admin-dialog-actions">
                {conflict ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      void query.refetch().then((result) => {
                        if (result.data) {
                          setTemplate(result.data.configuration.promptTemplate);
                          setEditRevision(result.data.revision);
                          setConflict(false);
                          setMessage('');
                        }
                      });
                    }}
                  >
                    {t('Reload')}
                  </Button>
                ) : null}
                {data.canManage ? (
                  <>
                    <Button
                      variant="ghost"
                      disabled={busy || conflict}
                      onClick={() => setTemplate(DEFAULT_MCP_PROMPT_TEMPLATE)}
                    >
                      {t('Restore default prompt')}
                    </Button>
                    <Button type="submit" loading={busy} disabled={conflict}>
                      {t('Save prompt')}
                    </Button>
                  </>
                ) : null}
              </div>
            </form>
          </EditorDialog>
        </div>
      ) : null}
      {!editing && message ? (
        <p role="status" className="mt-3">
          {message}
        </p>
      ) : null}
      {!editing && conflict ? (
        <Button
          variant="secondary"
          onClick={() => {
            void query.refetch().then(() => setConflict(false));
          }}
        >
          {t('Reload')}
        </Button>
      ) : null}
    </Card>
  );
}
