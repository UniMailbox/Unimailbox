import { useT } from '../../infrastructure/i18n/locale';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize2, Minimize2, Trash2, X } from 'lucide-react';
import { Button } from '../../components/ui/shadcn/button';
import { ComposeEmail } from './ComposeEmail';
import { mailboxListQuery } from './mailbox-queries';
import type { ComposeRequest } from './compose-window-context';

export function ComposeWindow({
  request,
  visible,
  fullScreen,
  onResize,
  onHide,
  onDiscard,
}: {
  request: ComposeRequest;
  visible: boolean;
  fullScreen: boolean;
  onResize: () => void;
  onHide: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const content = useRef<HTMLDivElement>(null);
  const [discarding, setDiscarding] = useState(false);
  const mailbox = mailboxListQuery().data?.find((item) => item.id === request.mailboxId);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      (content.current?.querySelector<HTMLElement>('#compose-to') ?? content.current)?.focus();
    });
    const overflow = document.body.style.overflow;
    if (fullScreen) document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
    };
  }, [visible, fullScreen]);
  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!fullScreen || event.key !== 'Tab') return;
    const controls = Array.from(
      content.current?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [contenteditable="true"]',
      ) ?? [],
    ).filter(
      (item) => !item.hasAttribute('disabled') && !item.hidden && item.getClientRects().length > 0,
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  return (
    // Keep modal=false and the content mounted across zoom/hide changes: toggling Radix's
    // modal branch remounts the editor. Background inert + Tab trapping apply only fullscreen.
    <Dialog.Root open modal={false}>
      <Dialog.Portal forceMount>
        <Dialog.Content
          ref={content}
          aria-modal={visible && fullScreen ? true : undefined}
          className={`compose-window ${fullScreen ? 'compose-window-full' : 'compose-window-docked'}`}
          style={{ display: visible ? undefined : 'none' }}
          aria-describedby="compose-from"
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            onHide();
          }}
          onKeyDown={trapFocus}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.querySelector<HTMLInputElement>('#compose-to')?.focus();
          }}
        >
          <header className="compose-window-header">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={fullScreen ? t('Zoom out') : t('Zoom in')}
              title={fullScreen ? t('Zoom out') : t('Zoom in')}
              onClick={onResize}
            >
              {fullScreen ? <Minimize2 /> : <Maximize2 />}
            </Button>
            <Dialog.Title className="font-semibold">{t('New message')}</Dialog.Title>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ms-auto"
              aria-label={t('Discard draft')}
              onClick={() => setDiscarding(true)}
            >
              <Trash2 />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('Hide compose')}
              title={t('Hide compose (draft kept until you leave the app)')}
              onClick={onHide}
            >
              <X />
            </Button>
          </header>
          <Dialog.Description id="compose-from" className="compose-window-from">
            {t('From: ')}
            {mailbox?.address ?? t('Loading mailbox…')}
          </Dialog.Description>
          {discarding ? (
            <div className="flex flex-wrap items-center gap-2 border-b p-3" role="alert">
              <span className="text-sm">{t('Discard this unsent message?')}</span>
              <Button variant="destructive" size="sm" onClick={onDiscard}>
                {t('Discard message')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDiscarding(false)}>
                {t('Keep editing')}
              </Button>
            </div>
          ) : null}
          <div className="compose-window-body">
            <ComposeEmail
              mailboxId={request.mailboxId}
              replyToMessageId={request.replyToMessageId}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
