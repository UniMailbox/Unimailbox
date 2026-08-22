// Card primitive — section wrapper for wizard step bodies.
// CAP-041 ships a presentational wrapper. Step components compose the
// title/description/children — the component itself is agnostic of the
// step's content.
import type { ReactElement, ReactNode } from 'react';

export interface CardProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
}

export function Card({ title, description, children, actions, testId }: CardProps): ReactElement {
  return (
    <section className="card" data-testid={testId}>
      {title !== undefined ? <h2 className="card-title">{title}</h2> : null}
      {description !== undefined ? <p className="card-description">{description}</p> : null}
      {children}
      {actions !== undefined ? <div className="wizard-actions">{actions}</div> : null}
    </section>
  );
}
