import type { ComponentProps, ReactElement } from 'react';
import { Table as Primitive } from './shadcn/table';
import { useT } from '../../infrastructure/i18n/locale';
export {
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from './shadcn/table';
export function Table({
  scrollLabel,
  ...props
}: ComponentProps<'table'> & { readonly scrollLabel?: string }): ReactElement {
  const t = useT();
  return (
    <div {...(scrollLabel ? { role: 'region', tabIndex: 0, 'aria-label': t(scrollLabel) } : {})}>
      <Primitive {...props} />
    </div>
  );
}
