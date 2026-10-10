import type { ReactElement } from 'react';
import type { MessageDetail } from '@unimailbox/contracts';
import { sanitizeMessageHtml } from './sanitize-message-html';

export interface SanitizedMessageHtmlProps {
  readonly htmlBody: string;
  readonly attachments: MessageDetail['attachments'];
  readonly inlineImageUrls?: ReadonlyMap<string, string>;
}

/** The sole HTML insertion boundary for the sanitized message body. */
export function SanitizedMessageHtml({
  htmlBody,
  attachments,
  inlineImageUrls,
}: SanitizedMessageHtmlProps): ReactElement {
  const sanitizedHtml = sanitizeMessageHtml({
    htmlBody,
    attachments,
    inlineImageUrls,
  });
  return (
    <div
      className="message-detail-html-body"
      data-testid="message-html-body"
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
