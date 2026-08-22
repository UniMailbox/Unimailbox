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
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { Alert } from '../../../components/ui/Alert';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setupQueryKeys } from '../setup-queries';
import { clearSetupSession } from '../setup-session-store';

interface StartResult {
  readonly smokeTestAddress: string;
}

interface CheckResult {
  readonly status: 'pending' | 'received';
}

export function InboundSmokeStep(): ReactElement {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pollingEnabled, setPollingEnabled] = useState(false);

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
    queryKey: [...setupQueryKeys.all, 'inbound-smoke-check'] as const,
    queryFn: async () => {
      const response = await apiClient.fetch<{ data: CheckResult }>(
        '/api/v1/setup/inbound-smoke-test/check',
        { method: 'POST', body: {} },
      );
      return response.data;
    },
    enabled: pollingEnabled && startQuery.data !== undefined,
    refetchInterval: 5_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (startQuery.isSuccess && !pollingEnabled) {
      setPollingEnabled(true);
    }
  }, [startQuery.isSuccess, pollingEnabled]);

  useEffect(() => {
    if (checkQuery.data?.status === 'received') {
      setPollingEnabled(false);
      void queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      void navigate({ to: '/setup/brevo' });
    }
  }, [checkQuery.data, navigate, queryClient]);

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    clearSetupSession();
    void navigate({ to: '/setup/claim' });
  };

  const renderError = (
    error: unknown,
    retry: () => void,
  ): ReactElement => {
    if (error instanceof ApiError) {
      const isUnauthorized = error.status === 401;
      return (
        <ErrorPanel
          message={error.message}
          code={error.code}
          retryLabel={
            isUnauthorized ? 'Re-claim installation token' : 'Retry'
          }
          onRetry={isUnauthorized ? handleReclaim : retry}
        />
      );
    }
    return (
      <ErrorPanel
        message="Unexpected error"
        code="UNEXPECTED_ERROR"
        onRetry={retry}
      />
    );
  };

  return (
    <Card
      title="Inbound smoke test"
      description="Send an email to the smoke test address to confirm routing."
    >
      <div role="status" aria-live="polite">
        {startQuery.isPending ? (
          <p data-testid="inbound-starting">
            <Spinner label="Starting inbound smoke test" />
          </p>
        ) : null}
        {startQuery.data !== undefined ? (
          <Alert variant="info" testId="inbound-address">
            Send an email to: <code>{startQuery.data.smokeTestAddress}</code>
          </Alert>
        ) : null}
        {checkQuery.isPending && startQuery.data !== undefined ? (
          <p data-testid="inbound-checking">
            <Spinner label="Waiting for inbound message" />
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
            void checkQuery.refetch();
          })
        : null}
      <div className="wizard-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={checkQuery.isFetching}
          aria-busy={checkQuery.isFetching}
          onClick={() => {
            void checkQuery.refetch();
          }}
          data-testid="inbound-check-now"
        >
          {checkQuery.isFetching ? <Spinner /> : 'Check now'}
        </Button>
      </div>
    </Card>
  );
}