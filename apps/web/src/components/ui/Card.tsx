import type { ReactElement, ReactNode } from 'react';
import {
  Card as Primitive,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './shadcn/card';
export interface CardProps {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
}
export function Card({ title, description, children, actions, testId }: CardProps): ReactElement {
  return (
    <Primitive data-testid={testId}>
      {title !== undefined || description !== undefined ? (
        <CardHeader>
          {title !== undefined ? (
            <CardTitle>
              <h2>{title}</h2>
            </CardTitle>
          ) : null}
          {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      {children !== undefined ? <CardContent>{children}</CardContent> : null}
      {actions !== undefined ? (
        <CardFooter className="flex flex-wrap gap-2">{actions}</CardFooter>
      ) : null}
    </Primitive>
  );
}
