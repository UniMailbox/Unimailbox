import { useT } from '../../infrastructure/i18n/locale';
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
  const t = useT();
  return (
    <aside className="setup-guidance" data-testid={testId} aria-label={t('Step instructions')}>
      <div className="setup-guidance-header">
        <span className="setup-guidance-kicker">{t('Operator guide')}</span>
        <h3 className="setup-guidance-title">{t('Complete this step')}</h3>
      </div>
      <div className="setup-guidance-sections">
        <section className="setup-guidance-section">
          <h4>{t('Purpose')}</h4>
          <p>{typeof purpose === 'string' ? t(purpose) : purpose}</p>
        </section>
        {prepare !== undefined ? (
          <section className="setup-guidance-section">
            <h4>{t('Prepare')}</h4>
            <p>{typeof prepare === 'string' ? t(prepare) : prepare}</p>
          </section>
        ) : null}
        <section className="setup-guidance-section setup-guidance-actions">
          <h4>{t('What to do')}</h4>
          <ol>
            {steps.map((step, index) => (
              <li key={index}>{typeof step === 'string' ? t(step) : step}</li>
            ))}
          </ol>
        </section>
        <section className="setup-guidance-section">
          <h4>{t('After success')}</h4>
          <p>{typeof success === 'string' ? t(success) : success}</p>
        </section>
      </div>
      {note !== undefined ? (
        <p className="setup-guidance-note">{typeof note === 'string' ? t(note) : note}</p>
      ) : null}
    </aside>
  );
}
