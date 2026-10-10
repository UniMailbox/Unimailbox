import type { ReactElement, ReactNode } from 'react';
export function ConfigurationSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="configuration-section">
      <div className="configuration-heading">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="configuration-fields">{children}</div>
    </section>
  );
}
