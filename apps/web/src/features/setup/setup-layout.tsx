// apps/web — setup layout.
//
// CAP-041 wires the wizard. The layout renders the step indicator (a chip
// per installation step, with state baked in via `data-state`), the active
// step's body via <Outlet>, and a "Restart wizard" affordance that clears
// the in-memory session token and navigates to /setup/claim.
//
// The layout never makes API calls directly. It calls `setupStatusQuery()`
// to read the current step — the step children do their own data fetching.
//
// M7 (CAP-041 fix): STEPS is derived from `installationStepSchema.options`
// so the chip order matches the zod contract exactly. No more dual
// sources of truth.
//
// HIGH 2 (CAP-041 fix): the step indicator carries `aria-current="step"`
// on the active chip and a descriptive `aria-label` on every chip so a
// screen reader hears "Step 5 of 9: Inbound smoke, current".
import { useNavigate, Outlet } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import {
  installationStepSchema,
  type InstallationStep,
} from '@unimailbox/contracts';
import { Button } from '../../components/ui/Button';
import { clearSetupSession } from './setup-session-store';
import { setupStatusQuery } from './setup-queries';

const STEP_LABELS: Readonly<Record<InstallationStep, string>> = {
  claim: 'Claim',
  preflight: 'Preflight',
  administrator: 'Administrator',
  domain: 'Domain',
  'cloudflare-verify': 'Cloudflare',
  'inbound-smoke': 'Inbound',
  brevo: 'Brevo',
  'outbound-smoke': 'Outbound',
  complete: 'Complete',
};

// M7 (CAP-041 fix): derived directly from the contracts schema. If a new
// step is added to the schema, `STEP_LABELS` will fail to compile until
// the label is added — that's the structural enforcement.
const STEPS: ReadonlyArray<InstallationStep> =
  installationStepSchema.options as ReadonlyArray<InstallationStep>;

export function SetupLayout(): ReactElement {
  const navigate = useNavigate();
  const [showConfirm, setShowConfirm] = useState(false);
  // H1 (CAP-041 fix): the layout reads the status via the same query the
  // router used to use. The query is shared with the router's caller via
  // the QueryClient; status updates flow into the chip indicator without
  // any extra wiring.
  const statusQuery = setupStatusQuery();
  const currentStepKey: InstallationStep | null =
    statusQuery.data?.currentStep ?? null;
  const currentIndex =
    currentStepKey === null ? -1 : STEPS.findIndex((s) => s === currentStepKey);
  const totalSteps = STEPS.length;

  const handleRestart = (): void => {
    // Frontend HIGH 1 (CAP-041 fix): the operator might have spent time
    // configuring provider keys. Confirm before discarding the in-memory
    // session token; a hard restart sends them back to /setup/claim.
    if (!showConfirm) {
      setShowConfirm(true);
      return;
    }
    clearSetupSession();
    void navigate({ to: '/setup/claim' });
  };

  return (
    <main className="wizard" data-testid="setup-layout">
      <header className="wizard-header">
        <h1 className="wizard-title">Set up Unimailbox</h1>
        <p className="wizard-subtitle">
          Walk through the deployment steps to bring the system online.
        </p>
      </header>
      <nav aria-label="Wizard progress">
        <ol className="wizard-steps">
          {STEPS.map((step, index) => {
            const stateAttr: 'complete' | 'current' | 'upcoming' =
              index < currentIndex
                ? 'complete'
                : index === currentIndex
                  ? 'current'
                  : 'upcoming';
            const labelText = STEP_LABELS[step];
            // HIGH 2 (CAP-041 fix): aria-label describes the chip's
            // position + state in human terms, and aria-current marks the
            // active step for AT users.
            const ariaLabel = `Step ${String(index + 1)} of ${String(totalSteps)}: ${labelText}, ${stateAttr}`;
            return (
              <li
                key={step}
                className="wizard-step"
                data-state={stateAttr}
                data-testid={`step-${step}`}
                aria-current={stateAttr === 'current' ? 'step' : undefined}
                aria-label={ariaLabel}
              >
                <span>{labelText}</span>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="wizard-body">
        <Outlet />
      </div>
      <footer className="wizard-footer">
        {showConfirm ? (
          <p
            className="wizard-subtitle"
            role="alert"
            data-testid="restart-confirm"
          >
            Restarting will clear your in-memory session token. Click
            &ldquo;Restart wizard&rdquo; again to confirm.
          </p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleRestart}
          data-testid="restart-wizard"
        >
          {showConfirm ? 'Confirm restart' : 'Restart wizard'}
        </Button>
      </footer>
    </main>
  );
}