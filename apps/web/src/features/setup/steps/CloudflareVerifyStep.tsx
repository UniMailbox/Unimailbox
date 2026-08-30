// apps/web — CloudflareVerifyStep.
//
// CAP-041 / step 5. On mount, asks the Worker for the Cloudflare dashboard
// link, opens it in a new tab, then lets the operator confirm they have
// configured Email Routing. On confirmation, posts /cloudflare/verify.
// R-SECRET-003: the URL is allowlisted server-side; this step never
// injects a user-supplied URL.
//
// MEDIUM (CAP-041 fix): when the browser blocks the popup (window.open
// returns null), the operator never sees the dashboard. Disable the
// confirm button until they retry the link and the browser actually
// opens the tab.
//
// HIGH 2 (CAP-041 fix): if /cloudflare/verify returns 401 the session
// token is gone — surface a re-claim affordance.
//
// CAP-063: skip button rendered via <SkipRemainingSetupButton /> below
// the wizard actions. R-WORKFLOW-002 reuses the existing /complete
// endpoint. The popup-blocked state gates ONLY the confirm button, not
// skip — operators can skip past a blocked popup.
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { Spinner } from '../../../components/ui/Spinner';
import { ErrorPanel } from '../../../components/ui/ErrorPanel';
import { Alert } from '../../../components/ui/Alert';
import { ApiError } from '../../../infrastructure/api/errors';
import { useApiClient } from '../../../infrastructure/api/client-provider';
import { setupQueryKeys } from '../setup-queries';
import {
  reclaimInstallationToken,
  useSkipRemainingSetup,
} from '../use-skip-remaining-setup';
import { SkipRemainingSetupButton } from '../SkipRemainingSetupButton';
import { SetupGuidance } from '../setup-guidance';

export function CloudflareVerifyStep(): ReactElement {
  const apiClient = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const skipRemaining = useSkipRemainingSetup();
  const [linkError, setLinkError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);
  const [linkLoading, setLinkLoading] = useState(true);
  const [linkLoaded, setLinkLoaded] = useState(false);
  // MEDIUM (CAP-041 fix): window.open can return null when the browser
  // suppresses the popup. Track it so the confirm button stays disabled.
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [verifyError, setVerifyError] = useState<{
    readonly message: string;
    readonly code: string;
    readonly status: number | null;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const fetchLink = async (): Promise<void> => {
    try {
      const response = await apiClient.fetch<{ data: { url: string } }>(
        '/api/v1/setup/cloudflare/dashboard-link',
        { method: 'POST', body: {} },
      );
      const opened = window.open(response.data.url, '_blank', 'noopener,noreferrer');
      // MEDIUM (CAP-041 fix): null means the popup was blocked. The
      // operator must allow popups (or click the link manually) before
      // continuing; we surface a notice and disable the confirm button.
      if (opened === null) {
        setPopupBlocked(true);
      } else {
        setPopupBlocked(false);
      }
      setLinkLoading(false);
      setLinkLoaded(true);
    } catch (error) {
      if (error instanceof ApiError) {
        setLinkError({
          message: error.message,
          code: error.code,
          status: error.status,
        });
      } else {
        setLinkError({
          message: 'Unexpected error',
          code: 'UNEXPECTED_ERROR',
          status: null,
        });
      }
      setLinkLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const open = async (): Promise<void> => {
      if (cancelled) return;
      await fetchLink();
    };
    void open();
    return () => {
      cancelled = true;
    };
    // fetchLink closes over `apiClient`; the effect re-runs only when
    // the client identity changes (it never does — see B2 fix).
  }, [apiClient]);

  // HIGH 2 (CAP-041 fix): 401 → re-claim the installation token.
  const handleReclaim = (): void => {
    reclaimInstallationToken(navigate);
  };

  const onConfirm = async (): Promise<void> => {
    setVerifyError(null);
    setVerifying(true);
    try {
      await apiClient.fetch('/api/v1/setup/cloudflare/verify', {
        method: 'POST',
        body: {},
      });
      await queryClient.invalidateQueries({ queryKey: setupQueryKeys.status() });
      await navigate({ to: '/setup/inbound-smoke' });
    } catch (error) {
      if (error instanceof ApiError) {
        setVerifyError({
          message: error.message,
          code: error.code,
          status: error.status,
        });
      } else {
        setVerifyError({
          message: 'Unexpected error',
          code: 'UNEXPECTED_ERROR',
          status: null,
        });
      }
    } finally {
      setVerifying(false);
    }
  };

  const verifyErrorMessage = verifyError?.message ?? '';
  const verifyErrorCode = verifyError?.code ?? '';
  const verifyErrorStatus = verifyError?.status ?? null;
  const isUnauthorized = verifyErrorStatus === 401;

  return (
    <Card
      title="Verify Cloudflare Email Routing"
      description="Open the Cloudflare dashboard, configure Email Routing, then continue."
    >
      <SetupGuidance
        purpose="Connect the managed domain to Cloudflare Email Routing so inbound messages can reach the Worker."
        prepare="Access to the Cloudflare account that controls the managed domain."
        steps={[
          'Open the Cloudflare Dashboard link in a new tab.',
          'Configure Email Routing for the managed domain and complete any DNS or MX prompts.',
          'Return here and select I have configured email routing.',
        ]}
        success="The domain configuration is recorded and the wizard starts the inbound smoke test."
        note="This step is operator confirmation in the current release. The real routing check happens when the smoke-test email arrives."
      />
      {linkLoading ? (
        <p data-testid="cloudflare-loading">
          <Spinner label="Opening Cloudflare dashboard" />
        </p>
      ) : null}
      {linkError !== null ? (
        <ErrorPanel
          message={linkError.message}
          code={linkError.code}
          onRetry={() => {
            setLinkError(null);
            setLinkLoading(true);
            setLinkLoaded(false);
            void fetchLink();
          }}
        />
      ) : null}
      {popupBlocked ? (
        <Alert variant="warning" testId="cloudflare-popup-blocked">
          The browser blocked the popup. Allow popups for this site, then re-open the dashboard link
          below.
        </Alert>
      ) : null}
      {linkLoaded && !popupBlocked ? (
        <p className="wizard-subtitle" data-testid="cloudflare-opened">
          A new tab was opened with the Cloudflare dashboard.
        </p>
      ) : null}
      {verifyError !== null ? (
        <ErrorPanel
          message={verifyErrorMessage}
          code={verifyErrorCode}
          retryLabel={isUnauthorized ? 'Re-claim installation token' : 'Retry'}
          onRetry={isUnauthorized ? handleReclaim : () => void onConfirm()}
        />
      ) : null}
      <div className="wizard-actions">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!linkLoaded}
          onClick={() => void fetchLink()}
          data-testid="cloudflare-reopen"
        >
          Re-open dashboard link
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!linkLoaded || popupBlocked || verifying}
          onClick={() => void onConfirm()}
          aria-busy={verifying}
          data-testid="cloudflare-confirm"
        >
          {verifying ? <Spinner /> : 'I have configured email routing'}
        </Button>
      </div>
      {skipRemaining.error !== null ? (
        <ErrorPanel
          message={skipRemaining.error.message}
          code={skipRemaining.error.code}
          retryLabel={skipRemaining.isUnauthorized ? 'Re-claim installation token' : 'Retry'}
          onRetry={
            skipRemaining.isUnauthorized
              ? handleReclaim
              : () => void skipRemaining.skip()
          }
        />
      ) : null}
      <SkipRemainingSetupButton
        onSkip={() => void skipRemaining.skip()}
        submitting={skipRemaining.submitting}
      />
    </Card>
  );
}