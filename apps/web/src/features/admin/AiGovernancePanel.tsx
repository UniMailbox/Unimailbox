import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  aiGovernancePolicySchema,
  aiGovernanceSnapshotSchema,
  type AiGovernancePolicy,
} from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { useT } from '../../infrastructure/i18n/locale';
import { authSessionQuery } from '../auth/auth-queries';
import { useAiConfiguration } from './ai-queries';
import { AiUsagePanel } from './AiUsagePanel';
import { Card } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Label } from '../../components/ui/shadcn/label';
import { SelectField } from '../../components/ui/SelectField';
import { EditorDialog } from '../../components/ui/EditorDialog';

const fields = [
  ['monthlyTokens', 'Installation monthly tokens'],
  ['dailyTokens', 'Installation daily tokens'],
  ['userMonthlyTokens', 'Default user monthly tokens'],
  ['userDailyTokens', 'Default user daily tokens'],
  ['installationConcurrency', 'Installation concurrency'],
  ['userConcurrency', 'User concurrency'],
  ['maxInputBytes', 'Maximum input bytes'],
  ['maxInputTokens', 'Maximum input token reservation'],
] as const;
export function AiGovernancePanel() {
  const t = useT();
  const client = useApiClient();
  const cache = useQueryClient();
  const userId = authSessionQuery().data?.userId;
  const configuration = useAiConfiguration();
  const query = useQuery({
    queryKey: ['ai-governance', userId],
    enabled: !!userId,
    retry: false,
    queryFn: async () =>
      aiGovernanceSnapshotSchema.parse(
        (await client.fetch<{ data: unknown }>('/api/v1/admin/ai-governance')).data,
      ),
  });
  const [form, setForm] = useState<AiGovernancePolicy | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    const parsed = aiGovernancePolicySchema.safeParse(form);
    if (!parsed.success) {
      setError(t('Check the policy values and verified model profile.'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await client.fetch<{ data: unknown }>('/api/v1/admin/ai-governance', {
        method: 'PUT',
        body: parsed.data,
        headers: { 'If-Match': String(revision) },
        retry: false,
      });
      cache.setQueryData(
        ['ai-governance', userId],
        aiGovernanceSnapshotSchema.parse(response.data),
      );
      await cache.invalidateQueries({ queryKey: ['ai-usage', userId] });
      setForm(null);
    } catch {
      setError(t('Could not save AI governance. Reload the policy before retrying.'));
    } finally {
      setBusy(false);
    }
  }
  const profile = form?.verifiedProfile;
  return (
    <>
      <Card title={t('AI usage governance')}>
        {query.isPending ? <p role="status">{t('Loading AI policy…')}</p> : null}
        {query.isError ? (
          <p role="alert">
            {t('AI policy is unavailable.')}{' '}
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {t('Reload policy')}
            </Button>
          </p>
        ) : null}
        {query.data ? (
          <div className="grid gap-3">
            <p>
              {t('Mode')}: {t(query.data.policy.mode)}
            </p>
            <p>
              {t(
                'Installation and user token budgets apply together. Costs are estimates; all periods use UTC.',
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              {t(
                'Enforcement requires evidence for the byte-token upper bound, protocol overhead, context window and output cap at the exact AI configuration revision. Unverified models remain in observation mode or are refused.',
              )}
            </p>
            {query.data.blockedReason ? (
              <p role="alert">
                {t(
                  'AI admission is paused after a reservation overrun. Record new model verification evidence before resuming.',
                )}
              </p>
            ) : null}
            {query.data.canManage ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setForm(query.data.policy);
                  setRevision(query.data.revision);
                  setError('');
                }}
              >
                {t('Edit AI governance')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
      <AiUsagePanel admin canManage={query.data?.canManage ?? false} />
      <EditorDialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setForm(null);
        }}
        title={t('Edit AI governance')}
        description={t(
          'Zero tokens denies admission in enforcement mode. Existing in-flight requests retain their original policy.',
        )}
      >
        {form ? (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Label htmlFor="ai-mode">{t('Mode')}</Label>
            <SelectField
              id="ai-mode"
              value={form.mode}
              options={['observe', 'enforce', 'paused'].map((value) => ({ value, label: value }))}
              onValueChange={(value) => {
                if (value === 'observe' || value === 'enforce' || value === 'paused')
                  setForm({ ...form, mode: value });
              }}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {fields.map(([key, label]) => (
                <label key={key} className="grid gap-1">
                  {t(label)}
                  <Input
                    type="number"
                    min={key.includes('Concurrency') ? 1 : 0}
                    required
                    id={`ai-policy-${key}`}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
                  />
                </label>
              ))}
            </div>
            <fieldset className="grid gap-3 rounded border p-3">
              <legend>{t('Verified model profile')}</legend>
              <p>
                {t('Current AI configuration revision')}: {configuration.data?.revision ?? '—'}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={form.verifiedProfile !== null}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      verifiedProfile: e.target.checked
                        ? {
                            configurationRevision: configuration.data?.revision ?? 0,
                            contextTokens: 128000,
                            overheadTokens: 1024,
                            verificationReference: '',
                          }
                        : null,
                    })
                  }
                />{' '}
                {t('Record independently verified model limits')}
              </label>
              {profile ? (
                <>
                  {(['configurationRevision', 'contextTokens', 'overheadTokens'] as const).map(
                    (key) => (
                      <label key={key}>
                        {t(
                          key === 'configurationRevision'
                            ? 'Verified configuration revision'
                            : key === 'contextTokens'
                              ? 'Context window tokens'
                              : 'Verified protocol overhead tokens',
                        )}
                        <Input
                          type="number"
                          min={0}
                          required
                          id={`ai-profile-${key}`}
                          value={profile[key]}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              verifiedProfile: {
                                ...profile,
                                [key]: Number(e.target.value),
                              },
                            })
                          }
                        />
                      </label>
                    ),
                  )}
                  <label>
                    {t('Verification reference (no private content)')}
                    <Input
                      id="ai-profile-evidence"
                      value={profile.verificationReference}
                      required
                      minLength={8}
                      maxLength={200}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          verifiedProfile: {
                            ...profile,
                            verificationReference: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
            <fieldset className="grid gap-3 rounded border p-3">
              <legend>{t('Estimated pricing')}</legend>
              <SelectField
                label="Currency"
                value={form.currency}
                options={[
                  { value: 'USD', label: 'USD' },
                  { value: 'CNY', label: 'CNY' },
                ]}
                onValueChange={(currency) => {
                  if (currency === 'USD' || currency === 'CNY') setForm({ ...form, currency });
                }}
              />
              {(['inputPricePerMillion', 'outputPricePerMillion'] as const).map((key) => (
                <label key={key}>
                  {t(
                    key === 'inputPricePerMillion'
                      ? 'Price per million input tokens'
                      : 'Price per million output tokens',
                  )}
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    id={`ai-price-${key}`}
                    value={form[key] ?? ''}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        [key]: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
              <p>
                {t(
                  'Leave unknown prices empty. Prices apply to the verified configuration revision. Cached input is included once; this estimate does not apply cache discounts.',
                )}
              </p>
            </fieldset>
            <fieldset className="grid gap-3 rounded border p-3">
              <legend>{t('Per-user overrides')}</legend>
              {form.userOverrides.map((row, index) => (
                <div key={index} className="grid gap-2 rounded border p-2">
                  <label>
                    {t('User ID')}
                    <Input
                      required
                      id={`ai-override-user-${index}`}
                      value={row.userId}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          userOverrides: form.userOverrides.map((r, i) =>
                            i === index ? { ...r, userId: e.target.value } : r,
                          ),
                        })
                      }
                    />
                  </label>
                  {(['monthlyTokens', 'dailyTokens'] as const).map((key) => (
                    <label key={key}>
                      {t(key === 'monthlyTokens' ? 'Monthly token limit' : 'Daily token limit')}
                      <Input
                        type="number"
                        min={0}
                        required
                        id={`ai-override-${index}-${key}`}
                        value={row[key]}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            userOverrides: form.userOverrides.map((r, i) =>
                              i === index ? { ...r, [key]: Number(e.target.value) } : r,
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setForm({
                        ...form,
                        userOverrides: form.userOverrides.filter((_, i) => i !== index),
                      })
                    }
                  >
                    {t('Remove override')}
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                disabled={form.userOverrides.length >= 100}
                onClick={() =>
                  setForm({
                    ...form,
                    userOverrides: [
                      ...form.userOverrides,
                      {
                        userId: '',
                        monthlyTokens: form.userMonthlyTokens,
                        dailyTokens: form.userDailyTokens,
                      },
                    ],
                  })
                }
              >
                {t('Add user override')}
              </Button>
            </fieldset>
            {error ? (
              <p role="alert">
                {error}{' '}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={async () => {
                    const result = await query.refetch();
                    if (result.data) {
                      setForm(result.data.policy);
                      setRevision(result.data.revision);
                      setError('');
                    }
                  }}
                >
                  {t('Reload policy')}
                </Button>
              </p>
            ) : null}
            <Button type="submit" disabled={busy}>
              {t('Save AI governance')}
            </Button>
          </form>
        ) : null}
      </EditorDialog>
    </>
  );
}
