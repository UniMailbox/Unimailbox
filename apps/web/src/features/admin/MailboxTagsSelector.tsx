import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import type { AdminUserMailboxItem } from '@unimailbox/contracts';
import { useT } from '../../infrastructure/i18n/locale';

/** Select existing mailbox IDs; typed text is only a catalogue filter. */
export function MailboxTagsSelector({
  mailboxes,
  selected,
  onChange,
  disabled,
}: {
  mailboxes: readonly Pick<AdminUserMailboxItem, 'id' | 'address' | 'displayName'>[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}): ReactElement {
  const t = useT();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLLIElement>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = mailboxes.filter((mailbox) =>
    `${mailbox.address} ${mailbox.displayName ?? ''}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const expanded = open && !disabled;
  useEffect(() => {
    if (expanded) activeOption.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, expanded, search]);
  const toggle = (id: string): void => {
    if (disabled) return;
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((current) =>
        !expanded
          ? event.key === 'ArrowUp'
            ? Math.max(0, matches.length - 1)
            : 0
          : matches.length === 0
            ? 0
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
      );
    } else if (event.key === 'Enter') {
      // Enter selects a mailbox; it must never submit the account form.
      event.preventDefault();
      if (expanded && matches[active]) toggle(matches[active].id);
      else setOpen(true);
    }
  };
  return (
    <div
      className="mailbox-tags-selector"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="mailbox-tags-control" data-disabled={disabled || undefined}>
        {selected.length > 0 ? (
          <ul className="mailbox-selected-tags" aria-label={t('Assigned mailboxes')}>
            {mailboxes
              .filter((mailbox) => selected.includes(mailbox.id))
              .map((mailbox) => (
                <li key={mailbox.id} className="mailbox-selected-tag">
                  <span>{mailbox.address}</span>
                  <button
                    type="button"
                    aria-label={t('Remove {value0}', { value0: mailbox.address })}
                    disabled={disabled}
                    onClick={() => {
                      toggle(mailbox.id);
                      input.current?.focus();
                    }}
                  >
                    <X aria-hidden="true" />
                  </button>
                </li>
              ))}
          </ul>
        ) : null}
        <div className="mailbox-tags-search">
          <input
            ref={input}
            role="combobox"
            type="text"
            autoComplete="off"
            aria-label={t('Search mailboxes')}
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            aria-activedescendant={expanded && matches[active] ? `${listId}-${active}` : undefined}
            placeholder={t('Search and select mailboxes')}
            value={search}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setSearch(event.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={keyDown}
          />
          <button
            type="button"
            aria-label={t('Show mailbox options')}
            disabled={disabled}
            onClick={() => {
              input.current?.focus();
              setOpen(!expanded);
            }}
          >
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="mailbox-tags-options">
          <ul
            id={listId}
            role="listbox"
            aria-label={t('Available mailboxes')}
            aria-multiselectable="true"
          >
            {matches.map((mailbox, index) => (
              <li
                key={mailbox.id}
                ref={active === index ? activeOption : undefined}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={selected.includes(mailbox.id)}
                data-active={active === index || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => toggle(mailbox.id)}
              >
                <span>{mailbox.address}</span>
                {selected.includes(mailbox.id) ? <Check aria-hidden="true" /> : null}
              </li>
            ))}
          </ul>
          {matches.length === 0 ? <p role="status">{t('No matching mailboxes.')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
