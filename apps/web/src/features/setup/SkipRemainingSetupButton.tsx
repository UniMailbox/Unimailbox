// apps/web — SkipRemainingSetupButton.
//
// CAP-063: the shared visual for the wizard's "Skip remaining setup"
// affordance. One button shape across six step components; the only thing
// each step varies is whether the button is enabled (Administrator gates
// it on server truth) and whether it is mid-flight (spinner).
//
// Contract:
//   - `data-testid="setup-skip-remaining"` everywhere it is rendered.
//   - Label "Skip remaining setup" — no per-step rewording.
//   - `variant="secondary"` so it sits visually below the step's primary
//     CTA without competing with it.
//   - Spinner replaces the label while submitting so a11y is preserved
//     (`aria-busy={submitting}`).
import type { ReactElement } from 'react';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';

export interface SkipRemainingSetupButtonProps {
  /** Click handler. Pass the hook's `skip`; the hook is responsible for guarding re-entry. */
  readonly onSkip: () => void;
  /** True while the underlying request is in flight. Disables the button + shows spinner. */
  readonly submitting: boolean;
  /**
   * Per-step override for the disabled prop. Defaults to false (the button
   * is always enabled on the five post-administrator steps). AdministratorStep
   * passes `disabled={!canSkip}` so the button stays blocked until an
   * administrator row exists (D-CAP-063-2 / R-AUTH-005).
   */
  readonly disabled?: boolean;
}

export function SkipRemainingSetupButton({
  onSkip,
  submitting,
  disabled = false,
}: SkipRemainingSetupButtonProps): ReactElement {
  return (
    <div className="wizard-actions">
      <Button
        type="button"
        variant="secondary"
        disabled={disabled || submitting}
        aria-busy={submitting}
        onClick={() => void onSkip()}
        data-testid="setup-skip-remaining"
      >
        {submitting ? <Spinner /> : 'Skip remaining setup'}
      </Button>
    </div>
  );
}