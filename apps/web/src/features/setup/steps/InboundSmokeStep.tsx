import { useT } from '../../../infrastructure/i18n/locale';
// apps/web — InboundSmokeStep.
//
// CAP-041 / step 6. Starts the inbound smoke test, then polls the
// check endpoint every 5s (R-WORKFLOW-003). Stops polling when status
// is 'received' and advances to /setup/brevo.
//
// MEDIUM (CAP-041 fix): the status text wraps in
// <div role="status" aria-live="polite"> so a screen reader announces
// transitions without re-reading the whole page. The check button
// carries aria-busy while a poll is in flight.
//
// HIGH 2 (CAP-041 fix): if either start or check returns 401 the
// session token is gone — surface a re-claim affordance.
//
// CAP-063: skip button rendered via <SkipRemainingSetupButton /> below
// the wizard actions. The hook stops the 5s check poll before leaving
// (an in-flight refetch after navigation would surface a stale
// ErrorPanel during the route transition).
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setupQueryKeys } from '../setup-queries';
import { reclaimInstallationToken, useSkipRemainingSetup } from '../use-skip-remaining-setup';
import { SkipRemainingSetupButton } from '../SkipRemainingSetupButton';
import { SetupGuidance } from '../setup-guidance';

interface StartResult {
  readonly smokeTestAddress: string;
  readonly expiresAt?: string;
}

interface CheckResult {
  readonly status: 'pending' | 'received' | 'expired';
}

export function InboundSmokeStep(): ReactElement {
  const t = useT();
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const [expired, setExpired] = useState(false);
  const skipRemaining = useSkipRemainingSetup();

  const startQuery = useQuery({
    queryKey: [...setupQueryKeys.all, 'inbound-smoke-start'] as const,
    queryFn: async () => {
      const response = await apiClient.fetch<{ data: StartResult }>(
        '/api/v1/setup/inbound-smoke-test',
        { method: 'POST', body: {} },
      );
      return response.data;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const checkQuery = useQuery({
    queryKey: [
      ...setupQueryKeys.all,
      'inbound-smoke-check',
      startQuery.data?.smokeTestAddress,
    ] as const,
    queryFn: async () => {
      const response = await apiClient.fetch<{ data: CheckResult }>(
        '/api/v1/setup/inbound-smoke-test/check',
        { method: 'GET' },
      );
      return response.data;
    },
    enabled: pollingEnabled && startQuery.data !== undefined,
    refetchInterval: (query) =>
      !query.state.error && query.state.data?.status === 'pending' ? 5_000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const confirmation = useMutation({
    mutationFn: () =>
      apiClient.fetch<{ data: CheckResult }>('/api/v1/setup/inbound-smoke-test/check', {
        method: 'POST',
        body: {},
      }),
    onSuccess: async (response) => {
      if (response.data.status !== 'received') {
        setExpired(true);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/setup/brevo' });
    },
    retry: false,
  });

  useEffect(() => {
    if (!startQuery.data) return;
    const deadline = startQuery.data.expiresAt
      ? Date.parse(startQuery.data.expiresAt)
      : startQuery.dataUpdatedAt + 300_000;
    const remaining = Number.isFinite(deadline) ? deadline - Date.now() : 0;
    setExpired(remaining <= 0);
    setPollingEnabled(remaining > 0);
    if (remaining <= 0) return;
    const timeout = setTimeout(() => {
      setExpired(true);
      setPollingEnabled(false);
    }, remaining);
    return () => clearTimeout(timeout);
  }, [startQuery.data, startQuery.dataUpdatedAt]);

  useEffect(() => {
    if (!expired && checkQuery.data?.status === 'received') {
      setPollingEnabled(false);
      if (confirmation.isIdle) confirmation.mutate();
    } else if (checkQuery.data?.status === 'expired') {
      setExpired(true);
      setPollingEnabled(false);
    }
    if (checkQuery.isError) setPollingEnabled(false);
  }, [checkQuery.data, checkQuery.isError, confirmation.isIdle, confirmation.mutate, expired]);

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    reclaimInstallationToken(navigate);
  };

  const renderError = (error: unknown, retry: () => void): ReactElement => {
    if (error instanceof ApiError) {
      const isUnauthorized = error.status === 401;
      return (
        <ErrorPanel
          message={error.message}
          code={error.code}
          retryLabel={isUnauthorized ? t('Re-claim installation token') : t('Retry')}
          onRetry={isUnauthorized ? handleReclaim : retry}
        />
      );
    }
    return <ErrorPanel message="Unexpected error" code="UNEXPECTED_ERROR" onRetry={retry} />;
  };

  return (
    <Card
      title={t('Inbound smoke test')}
      description={t('Send an email to the smoke test address to confirm routing.')}
    >
      <SetupGuidance
        purpose="Prove that an external email can travel through Cloudflare Email Routing into the Worker."
        prepare="An external mailbox from which you can send a test message."
        steps={[
          'Wait for the generated smoke-test address to appear.',
          'Send any email to that address from the external mailbox.',
          'Wait for the status to become received, or select Check now.',
        ]}
        success="The inbound route is confirmed and the wizard moves to Brevo configuration."
        note="The generated address expires after 5 minutes. If it expires, restart the test to generate a new address."
      />
      <div role="status" aria-live="polite">
        {startQuery.isPending ? (
          <p data-testid="inbound-starting">
            <Spinner label={t('Starting inbound smoke test')} />
          </p>
        ) : null}
        {startQuery.data !== undefined ? (
          <Alert variant="info" testId="inbound-address">
            {t('Send an email to: ')}
            <code>{startQuery.data.smokeTestAddress}</code>
          </Alert>
        ) : null}
        {checkQuery.isPending && startQuery.data !== undefined ? (
          <p data-testid="inbound-checking">
            <Spinner label={t('Waiting for inbound message')} />
          </p>
        ) : null}
      </div>
      {startQuery.isError && startQuery.error !== null
        ? renderError(startQuery.error, () => {
            void startQuery.refetch();
          })
        : null}
      {checkQuery.isError && checkQuery.error !== null
        ? renderError(checkQuery.error, () => {
            if (!expired) setPollingEnabled(true);
            void checkQuery.refetch();
          })
        : null}
      {confirmation.isError ? renderError(confirmation.error, () => confirmation.mutate()) : null}
      {expired ? (
        <Alert variant="info" testId="inbound-expired">
          {t('The test address has expired. Restart the test to generate a new address.')}
        </Alert>
      ) : null}
      <div className="wizard-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={checkQuery.isFetching || expired || !startQuery.data || confirmation.isPending}
          aria-busy={checkQuery.isFetching}
          onClick={() => {
            void checkQuery.refetch();
          }}
          data-testid="inbound-check-now"
        >
          {checkQuery.isFetching ? <Spinner /> : t('Check now')}
        </Button>
        {expired ? (
          <Button
            type="button"
            disabled={startQuery.isFetching}
            onClick={() => {
              confirmation.reset();
              void startQuery.refetch();
            }}
          >
            {t('Restart test')}
          </Button>
        ) : null}
      </div>
      {skipRemaining.error !== null ? (
        <ErrorPanel
          message={skipRemaining.error.message}
          code={skipRemaining.error.code}
          retryLabel={skipRemaining.isUnauthorized ? t('Re-claim installation token') : t('Retry')}
          onRetry={skipRemaining.isUnauthorized ? handleReclaim : () => void skipRemaining.skip()}
        />
      ) : null}
      <SkipRemainingSetupButton
        onSkip={() => {
          // Stop the 5s check poll before leaving: the smoke test is moot
          // once the installation is complete, and an in-flight refetch
          // would surface a stale ErrorPanel during the navigation.
          setPollingEnabled(false);
          void skipRemaining.skip();
        }}
        submitting={skipRemaining.submitting}
      />
    </Card>
  );
}
