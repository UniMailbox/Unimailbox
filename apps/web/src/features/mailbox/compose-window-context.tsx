import { ContentSkeleton } from '../../components/ui/ContentSkeleton';
import { Button } from '../../components/ui/shadcn/button';
import { X } from 'lucide-react';
import { useT } from '../../infrastructure/i18n/locale';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { useLocation } from '@tanstack/react-router';
import { authSessionQuery } from '../auth/auth-queries';

export interface ComposeRequest {
  mailboxId: string;
  replyToMessageId?: string | undefined;
}
interface ComposerContext {
  open: (request: ComposeRequest) => void;
  sent: () => void;
}
const Context = createContext<ComposerContext | null>(null);
export function useComposer(): ComposerContext | null {
  return useContext(Context);
}
const ComposeWindow = lazy(() =>
  import('./ComposeWindow').then((module) => ({ default: module.ComposeWindow })),
);

/** Keeps the mounted draft outside route layouts; no mail content is written to browser storage. */
export function ComposeWindowProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const session = authSessionQuery().data;
  const pathname = useLocation({ select: (location) => location.pathname });
  const [draft, setDraft] = useState<(ComposeRequest & { userId: string }) | null>(null);
  const [visible, setVisible] = useState(false);
  const [sentNotice, setSentNotice] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const hide = (): void => {
    setVisible(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  const [fullScreen, setFullScreen] = useState(true);
  const open = useCallback(
    (request: ComposeRequest) => {
      if (!session) return;
      trigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Reopening or switching mailbox must never replace an unsent draft silently.
      setDraft((current) =>
        current?.userId === session.userId ? current : { ...request, userId: session.userId },
      );
      setSentNotice(false);
      setFullScreen(true);
      setVisible(true);
    },
    [session],
  );
  useEffect(() => {
    if (draft && draft.userId !== session?.userId) {
      setDraft(null);
      setVisible(false);
    }
  }, [session, draft]);
  const allowedPage = pathname.startsWith('/mailbox') || pathname.startsWith('/admin');
  const shown = visible && allowedPage && draft?.userId === session?.userId;
  return (
    <Context.Provider
      value={{
        open,
        sent: () => {
          setDraft(null);
          hide();
          setSentNotice(true);
        },
      }}
    >
      <div inert={shown && fullScreen ? true : undefined}>{children}</div>
      {sentNotice && session ? (
        <div
          className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-md border bg-background px-4 py-2 shadow-md"
          role="status"
        >
          <span className="text-sm">{t('Message queued for sending.')}</span>
          <button
            type="button"
            className="text-sm text-muted-foreground"
            aria-label={t('Dismiss send confirmation')}
            onClick={() => setSentNotice(false)}
          >
            {t('Dismiss')}
          </button>
        </div>
      ) : null}
      {draft && draft.userId === session?.userId ? (
        <Suspense
          fallback={
            shown ? (
              <section className="compose-window compose-window-full" aria-label={t('New message')}>
                <header className="compose-window-header">
                  <span className="font-semibold">{t('New message')}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ms-auto"
                    aria-label={t('Hide compose')}
                    onClick={hide}
                  >
                    <X />
                  </Button>
                </header>
                <div className="compose-window-body p-4">
                  <ContentSkeleton variant="compose" />
                </div>
              </section>
            ) : null
          }
        >
          <ComposeWindow
            request={draft}
            visible={shown}
            fullScreen={fullScreen}
            onResize={() => setFullScreen((current) => !current)}
            onHide={hide}
            onDiscard={() => {
              setDraft(null);
              hide();
            }}
          />
        </Suspense>
      ) : null}
    </Context.Provider>
  );
}
