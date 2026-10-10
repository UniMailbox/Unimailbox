import { useT } from '../../infrastructure/i18n/locale';
import { Download, Paperclip } from 'lucide-react';
import { Button } from '../../components/ui/Button';
// apps/web — MessageAttachments.
//
// CAP-053/CAP-055: attachment controls and a narrow inline-raster preview.
// Binary reads go through the authenticated API client; direct browser
// navigation cannot carry the in-memory Bearer token.

import { useState, type ReactElement } from 'react';
import type { MessageDetail } from '@unimailbox/contracts';
import { attachmentDownloadHref, isPreviewableInlineRaster } from './message-attachment-media';
import { useApiClient } from '../../infrastructure/api/client-provider';

export interface MessageAttachmentsProps {
  readonly mailboxId: string;
  readonly attachments: MessageDetail['attachments'];
  readonly inlineImageUrls?: ReadonlyMap<string, string>;
}

export function MessageAttachments({
  mailboxId,
  attachments,
  inlineImageUrls,
}: MessageAttachmentsProps): ReactElement | null {
  const t = useT();
  const apiClient = useApiClient();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  if (attachments === undefined || attachments.length === 0) {
    return null;
  }

  async function saveAttachment(attachment: NonNullable<MessageDetail['attachments']>[number]) {
    setDownloadingId(attachment.id);
    setDownloadError(false);
    try {
      const bytes = await apiClient.fetch<ArrayBuffer>(
        attachmentDownloadHref(mailboxId, attachment.id),
        { responseType: 'arrayBuffer' },
      );
      if (bytes.byteLength !== attachment.sizeBytes) throw new Error('Incomplete attachment');
      const url = URL.createObjectURL(new Blob([bytes], { type: attachment.contentType }));
      const link = document.createElement('a');
      const revoke = URL.revokeObjectURL.bind(URL);
      try {
        link.href = url;
        link.download = attachment.filename;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => revoke(url), 30_000);
      }
    } catch {
      setDownloadError(true);
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <section className="message-attachments" data-testid="message-attachments">
      <h2 className="message-attachments-title flex items-center gap-2">
        <Paperclip className="size-4" />
        {t('Attachments ')}
      </h2>
      {downloadError ? (
        <p role="alert">{t('Could not download attachment. Please retry.')}</p>
      ) : null}
      <ul className="message-attachments-list">
        {attachments.map((attachment) => (
          <li className="message-attachment" data-testid="message-attachment" key={attachment.id}>
            <div className="message-attachment-metadata">
              <span data-testid="message-attachment-filename">{attachment.filename}</span>
              <span>{attachment.contentType}</span>
              <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
              <span>{attachment.disposition}</span>
            </div>
            {isPreviewableInlineRaster(attachment) && inlineImageUrls?.has(attachment.id) ? (
              <img
                src={inlineImageUrls.get(attachment.id)}
                alt={attachment.filename}
                data-testid="message-attachment-preview"
              />
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={downloadingId !== null}
              onClick={() => void saveAttachment(attachment)}
              aria-label={t('Download {value0}', { value0: attachment.filename })}
              data-testid="message-attachment-download"
            >
              <Download aria-hidden="true" />
              {downloadingId === attachment.id ? t('Downloading…') : t('Download')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = sizeBytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}
