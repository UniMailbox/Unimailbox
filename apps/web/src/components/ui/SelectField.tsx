import { useT } from '../../infrastructure/i18n/locale';
import type { ReactElement } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './shadcn/select';
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
/** Keeps real values independent from labels; empty selection maps through a private sentinel. */
export function SelectField({
  id,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  label,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}): ReactElement {
  const t = useT();
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={value === '' ? '__empty__' : value}
      onValueChange={(next) => onValueChange(next === '__empty__' ? '' : next)}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <SelectTrigger
        className="w-full min-w-0"
        {...(id === undefined ? {} : { id })}
        {...(label === undefined ? {} : { 'aria-label': t(label) })}
      >
        <SelectValue {...(placeholder === undefined ? {} : { placeholder: t(placeholder) })}>
          {selected ? t(selected.label) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value === '' ? '__empty__' : option.value}
            {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
          >
            {t(option.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
