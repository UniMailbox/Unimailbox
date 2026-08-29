// apps/web — MessageAttachments.
//
// CAP-053: metadata-only download controls for consumed attachments already
// returned by the authorized message-detail query. The browser follows the
// relative CAP-051 URL on activation; it never reads attachment bytes here.

import type { ReactElement } from 'react';
import type { MessageDetail } from '@unimailbox/contracts';

export interface MessageAttachmentsProps {
  readonly mailboxId: string;
  readonly attachments: MessageDetail['attachments'];
}

export function MessageAttachments({
  mailboxId,
  attachments,
}: MessageAttachmentsProps): ReactElement | null {
  if (attachments === undefined || attachments.length === 0) {
    return null;
  }

  return (
    <section className="message-attachments" data-testid="message-attachments">
      <h2 className="message-attachments-title">Attachments</h2>
      <ul className="message-attachments-list">
        {attachments.map((attachment) => (
          <li className="message-attachment" data-testid="message-attachment" key={attachment.id}>
            <div className="message-attachment-metadata">
              <span data-testid="message-attachment-filename">{attachment.filename}</span>
              <span>{attachment.contentType}</span>
              <span>{formatAttachmentSize(attachment.sizeBytes)}</span>
              <span>{attachment.disposition}</span>
            </div>
            <a
              href={attachmentDownloadHref(mailboxId, attachment.id)}
              aria-label={`Download ${attachment.filename}`}
              data-testid="message-attachment-download"
            >
              Download
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function attachmentDownloadHref(mailboxId: string, attachmentId: string): string {
  return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
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
