import { useEffect, useState } from 'react';
import type { MessageDetail } from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { attachmentDownloadHref, isPreviewableInlineRaster } from './message-attachment-media';

/** Fetches authorized inline images and revokes their object URLs on navigation. */
export function useInlineAttachmentUrls(
  mailboxId: string,
  attachments: MessageDetail['attachments'],
): ReadonlyMap<string, string> {
  const apiClient = useApiClient();
  const scope = `${mailboxId}:${(attachments ?? []).map((attachment) => attachment.id).join(',')}`;
  const [resolved, setResolved] = useState<{
    scope: string;
    urls: ReadonlyMap<string, string>;
  }>({ scope: '', urls: new Map() });

  useEffect(() => {
    const controller = new AbortController();
    const createdUrls: string[] = [];
    let active = true;
    const inlineImages = (attachments ?? []).filter(
      (attachment) => isPreviewableInlineRaster(attachment) && attachment.contentId,
    );

    for (const attachment of inlineImages) {
      void apiClient
        .fetch<ArrayBuffer>(attachmentDownloadHref(mailboxId, attachment.id), {
          responseType: 'arrayBuffer',
          signal: controller.signal,
        })
        .then((bytes) => {
          if (!active || bytes.byteLength !== attachment.sizeBytes) return;
          const mediaType = attachment.contentType.split(';', 1)[0]?.trim().toLowerCase();
          if (!mediaType || typeof URL.createObjectURL !== 'function') return;
          const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
          createdUrls.push(url);
          setResolved((current) => ({
            scope,
            urls: new Map(current.scope === scope ? current.urls : []).set(attachment.id, url),
          }));
        })
        .catch(() => {
          // An unavailable attachment simply remains an image without src.
        });
    }

    return () => {
      active = false;
      controller.abort();
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [apiClient, attachments, mailboxId, scope]);

  return resolved.scope === scope ? resolved.urls : new Map();
}
