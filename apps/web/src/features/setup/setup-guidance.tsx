// apps/web — shared setup-step guidance.
//
// The setup wizard is an operator workflow, not just a collection of forms.
// Keep the guidance shape consistent so every step answers the same four
// questions: why this step exists, what to prepare, what to do, and what
// success looks like.
import type { ReactElement, ReactNode } from 'react';

export interface SetupGuidanceProps {
  readonly purpose: ReactNode;
  readonly prepare?: ReactNode;
  readonly steps: readonly ReactNode[];
  readonly success: ReactNode;
  readonly note?: ReactNode;
  readonly testId?: string;
}

export function SetupGuidance({
  purpose,
  prepare,
  steps,
  success,
  note,
  testId = 'setup-guidance',
}: SetupGuidanceProps): ReactElement {
  return (
    <aside className="setup-guidance" data-testid={testId} aria-label="Step instructions">
      <div className="setup-guidance-header">
        <span className="setup-guidance-kicker">Operator guide</span>
        <h3 className="setup-guidance-title">Complete this step</h3>
      </div>
      <div className="setup-guidance-sections">
        <section className="setup-guidance-section">
          <h4>Purpose</h4>
          <p>{purpose}</p>
        </section>
        {prepare !== undefined ? (
          <section className="setup-guidance-section">
            <h4>Prepare</h4>
            <p>{prepare}</p>
          </section>
        ) : null}
        <section className="setup-guidance-section setup-guidance-actions">
          <h4>What to do</h4>
          <ol>
            {steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
        <section className="setup-guidance-section">
          <h4>After success</h4>
          <p>{success}</p>
        </section>
      </div>
      {note !== undefined ? <p className="setup-guidance-note">{note}</p> : null}
    </aside>
  );
}
