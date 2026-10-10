import { createContext, useContext } from 'react';
export const ReadingPaneContext = createContext<((messageId: string) => void) | null>(null);
export function useReadingPane(): ((messageId: string) => void) | null {
  return useContext(ReadingPaneContext);
}
