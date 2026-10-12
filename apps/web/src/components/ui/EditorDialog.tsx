import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import { cn } from '../../lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './shadcn/dialog';
/** Shared bounded editor; resource pages keep their data and mutation ownership. */
export function EditorDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  aboveCompose = false,
  compact = false,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  aboveCompose?: boolean;
  compact?: boolean;
  /** A chained confirmation can unmount the immediate opening control. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}): ReactElement {
  const restoreFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'editor-dialog max-h-[calc(100svh-2rem)] overflow-y-auto',
          compact ? 'sm:max-w-md' : 'sm:max-w-2xl',
          aboveCompose && 'z-[110]',
        )}
        {...(aboveCompose ? { overlayClassName: 'z-[100]' } : {})}
        onOpenAutoFocus={() => {
          restoreFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current ?? restoreFocus.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
