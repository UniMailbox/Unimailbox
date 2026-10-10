import type { MessageDetail } from '@unimailbox/contracts';

export type MessageAttachment = NonNullable<MessageDetail['attachments']>[number];

const INLINE_RASTER_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export function isPreviewableInlineRaster(attachment: MessageAttachment): boolean {
  if (attachment.disposition !== 'inline') {
    return false;
  }

  const mediaType = attachment.contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType !== undefined && INLINE_RASTER_MEDIA_TYPES.has(mediaType);
}

export function attachmentDownloadHref(mailboxId: string, attachmentId: string): string {
  return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
}
