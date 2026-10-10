import { useT } from '../../infrastructure/i18n/locale';
// apps/web — MessageThreadPanel.
//
// CAP-043 Slice 2 (AC 11). Lists the thread's messages oldest-first
// (the API contract order — rendered as received), highlights the
// active message, and navigates to a sibling's detail on click. Pure
// presentational: the data comes from `messageThreadQuery` in the
// parent, the navigation target is the message-detail route.
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { MessageListItem } from '@unimailbox/contracts';
import { LocalDateTime } from '../../components/ui/LocalDateTime';

export interface MessageThreadPanelProps {
  readonly mailboxId: string;
  readonly items: ReadonlyArray<MessageListItem>;
  readonly activeMessageId: string;
}

export function MessageThreadPanel({
  mailboxId,
  items,
  activeMessageId,
}: MessageThreadPanelProps): ReactElement {
  const t = useT();
  const navigate = useNavigate();

  return (
    <section className="message-thread-panel" data-testid="message-thread-panel">
      <h2 className="message-thread-title">
        {t('Thread (')}
        {items.length})
      </h2>
      <ul className="message-thread-list" data-testid="message-thread-list">
        {items.map((item) => {
          const isActive = item.id === activeMessageId;
          return (
            <li
              key={item.id}
              className={`message-thread-item${isActive ? ' message-thread-item-active' : ''}`}
              data-testid="message-thread-item"
              data-message-id={item.id}
              data-active={isActive ? 'true' : 'false'}
              aria-current={isActive ? 'true' : undefined}
            >
              <button
                type="button"
                className="message-thread-item-button"
                data-testid="message-thread-item-button"
                disabled={isActive}
                onClick={() => {
                  void navigate({
                    to: '/mailbox/$mailboxId/messages/$messageId',
                    params: { mailboxId, messageId: item.id },
                  });
                }}
              >
                <span className="message-thread-item-subject">{item.subject}</span>
                <span className="message-thread-item-meta">
                  {item.fromName !== ''
                    ? `${item.fromName} <${item.fromAddress}>`
                    : item.fromAddress}
                  {' · '}
                  <LocalDateTime value={item.createdAt} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
