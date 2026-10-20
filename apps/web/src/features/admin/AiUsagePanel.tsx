import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { aiUsageResponseSchema, type AiUsageResponse } from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { useT } from '../../infrastructure/i18n/locale';
import { authSessionQuery } from '../auth/auth-queries';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { EditorDialog } from '../../components/ui/EditorDialog';
import { Label } from '../../components/ui/shadcn/label';

export function AiUsagePanel({
  admin = false,
  canManage = false,
}: {
  admin?: boolean;
  canManage?: boolean;
}) {
  const t = useT();
  const client = useApiClient();
  const cache = useQueryClient();
  const userId = authSessionQuery().data?.userId;
  const [selected, setSelected] = useState<AiUsageResponse['attempts'][number] | null>(null);
  const [reference, setReference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['ai-usage', userId, admin ? 'installation' : 'personal'],
    enabled: !!userId,
    staleTime: 15_000,
    retry: false,
    queryFn: async () => {
      const response = await client.fetch<{ data: unknown }>(
        admin ? '/api/v1/admin/ai-governance/usage' : '/api/v1/auth/me/ai-usage',
        { retry: false },
      );
      return aiUsageResponseSchema.parse(response.data);
    },
  });
  const data = query.data,
    summary = data?.summary;
  async function reconcile() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await client.fetch(`/api/v1/admin/ai-governance/attempts/${selected.id}/reconcile`, {
        method: 'POST',
        retry: false,
        body: {
          confirmedTerminal: confirmed,
          evidenceReference: reference,
          inputTokens: input === '' ? null : Number(input),
          outputTokens: output === '' ? null : Number(output),
        },
      });
      setSelected(null);
      await cache.invalidateQueries({ queryKey: ['ai-usage', userId] });
    } catch {
      setError(t('Could not reconcile AI usage. Refresh and check the evidence.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card
      title={t(admin ? 'Installation AI usage' : 'Your AI usage')}
      testId={admin ? 'ai-installation-usage' : 'ai-personal-usage'}
    >
      {query.isPending ? <p role="status">{t('Loading AI usage…')}</p> : null}
      {query.isError ? <p role="alert">{t('AI usage is unavailable.')}</p> : null}
      <Button
        size="sm"
        variant="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {t('Refresh AI usage')}
      </Button>
      {summary ? (
        <div className="grid gap-3 mt-3">
          <p>
            {t('Mode')}: {t(summary.mode)} · {summary.period} UTC
          </p>
          {summary.mode === 'observe' ? (
            <p>
              {t(
                'Observation mode records usage; token quotas are not enforced. Concurrency limits still apply.',
              )}
            </p>
          ) : null}
          <progress
            aria-label={t('Monthly AI token usage')}
            className="w-full"
            max={Math.max(1, summary.monthlyLimit)}
            value={Math.min(
              summary.monthlyLimit,
              summary.chargedTokens + summary.reservedTokens + summary.unknownTokens,
            )}
          />
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {[
              [t('Charged tokens'), summary.chargedTokens],
              [t('Reserved tokens'), summary.reservedTokens],
              [t('Unknown token holds'), summary.unknownTokens],
              [t('Remaining monthly tokens'), summary.remainingTokens],
              [t('Monthly token limit'), summary.monthlyLimit],
              [t('Daily token use / limit'), `${summary.dailyUsed} / ${summary.dailyLimit}`],
              [t('Active / unknown requests'), `${summary.active} / ${summary.unknown}`],
              [t('Resets at (UTC)'), summary.resetsAt],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-muted-foreground">
            {t(
              'Unknown holds remain reserved until terminal evidence is recorded. Estimated costs are not a provider bill.',
            )}
          </p>
          {!data?.attempts.length ? (
            <p>{t('No AI requests recorded.')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="text-left">{t('Latest 20 AI requests')}</caption>
                <thead>
                  <tr>
                    <th>{t('Created')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Tokens')}</th>
                    <th>{t('Estimated cost')}</th>
                    {admin ? <th>{t('User ID')}</th> : null}
                    <th>{t('Actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.attempts.map((a) => (
                    <tr key={a.id}>
                      <td className="p-2 whitespace-nowrap">{a.createdAt} UTC</td>
                      <td>
                        {t(a.status)} · {t(a.usageKind)}
                      </td>
                      <td>{a.status === 'completed' ? a.chargedTokens : a.reservedTokens}</td>
                      <td>
                        {a.estimatedCost === null
                          ? '—'
                          : `${a.estimatedCost.toFixed(4)} ${a.currency}`}
                      </td>
                      {admin ? <td className="break-all">{a.actorUserId}</td> : null}
                      <td>
                        {admin && canManage && a.status !== 'completed' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setSelected(a);
                              setReference('');
                              setInput('');
                              setOutput('');
                              setConfirmed(false);
                              setError('');
                            }}
                          >
                            {t('Record terminal evidence')}
                          </Button>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
      <EditorDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
        title={t('Reconcile AI request')}
        description={t(
          'Only record independently confirmed provider completion. This never resubmits inference. Leave unknown token counts empty to retain a conservative charge.',
        )}
      >
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void reconcile();
          }}
        >
          <Label htmlFor="ai-evidence">{t('Evidence reference (no private content)')}</Label>
          <Input
            id="ai-evidence"
            value={reference}
            minLength={8}
            maxLength={200}
            required
            onChange={(e) => setReference(e.target.value)}
          />
          <Label htmlFor="ai-input-actual">{t('Confirmed input tokens')}</Label>
          <Input
            id="ai-input-actual"
            type="number"
            min={0}
            max={1_000_000_000}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <Label htmlFor="ai-output-actual">{t('Confirmed output tokens')}</Label>
          <Input
            id="ai-output-actual"
            type="number"
            min={0}
            max={1_000_000_000}
            value={output}
            onChange={(e) => setOutput(e.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              required
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            {t('I have verified that the upstream request has ended.')}
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <Button type="submit" disabled={busy || !confirmed}>
            {t('Save terminal evidence')}
          </Button>
        </form>
      </EditorDialog>
    </Card>
  );
}
