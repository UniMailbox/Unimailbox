// apps/web — MessageAttachments tests.
// CAP-053: presentational attachment metadata and relative download controls.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MessageDetail } from '@unimailbox/contracts';
import { MessageAttachments } from './MessageAttachments';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Attachment = NonNullable<MessageDetail['attachments']>[number];

const FIRST_ATTACHMENT: Attachment = {
  id: '00000000-0000-4000-8000-000000000002',
  filename: 'first.txt',
  contentType: 'text/plain',
  sizeBytes: 42,
  disposition: 'attachment',
  contentId: null,
};

const SECOND_ATTACHMENT: Attachment = {
  id: '00000000-0000-4000-8000-000000000001',
  filename: 'inline-image.png',
  contentType: 'image/png',
  sizeBytes: 1536,
  disposition: 'inline',
  contentId: 'cid-image',
};

describe('MessageAttachments', () => {
  it('R-ATTACHMENT-001/R-ATTACHMENT-006 preserves API order and builds encoded download links', () => {
    const mailboxId = 'mailbox/with space';
    const attachmentId = 'attachment/id?from=api';
    const attachments = [{ ...FIRST_ATTACHMENT, id: attachmentId }, SECOND_ATTACHMENT];

    render(<MessageAttachments mailboxId={mailboxId} attachments={attachments} />);

    const rows = screen.getAllByTestId('message-attachment');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('first.txt');
    expect(rows[1]).toHaveTextContent('inline-image.png');
    expect(rows[0]).toHaveTextContent('42 B');
    expect(rows[1]).toHaveTextContent('1.5 KB');
    expect(rows[0]).toHaveTextContent('attachment');
    expect(rows[1]).toHaveTextContent('inline');

    const links = screen.getAllByTestId('message-attachment-download');
    expect(links[0]).toHaveAttribute(
      'href',
      `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
    );
    expect(links[0]).toHaveAccessibleName('Download first.txt');
    expect(links[1]).toHaveAttribute(
      'href',
      `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/attachments/${encodeURIComponent(SECOND_ATTACHMENT.id)}/download`,
    );
  });

  it('R-API-001/R-API-002 handles empty and legacy attachment fields without throwing', () => {
    const { rerender } = render(<MessageAttachments mailboxId="mailbox-1" attachments={[]} />);
    expect(screen.queryByTestId('message-attachments')).not.toBeInTheDocument();

    rerender(<MessageAttachments mailboxId="mailbox-1" attachments={undefined} />);
    expect(screen.queryByTestId('message-attachments')).not.toBeInTheDocument();
  });

  it('R-SECRET-003/R-LOG-001 renders metadata as text without prefetching or leaking storage values', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sensitiveValues = {
      uploadId: 'upload-secret-sentinel',
      objectKey: 'object-key-secret-sentinel',
      bytes: 'attachment-bytes-secret-sentinel',
      idempotencyKey: 'Idempotency-Key: secret-sentinel',
    };
    const unsafeFilename = '<img src="x" onerror="alert(1)">';
    const attachment = {
      ...FIRST_ATTACHMENT,
      filename: unsafeFilename,
      uploadId: sensitiveValues.uploadId,
      objectKey: sensitiveValues.objectKey,
      bytes: sensitiveValues.bytes,
      idempotencyKey: sensitiveValues.idempotencyKey,
    } as Attachment;

    const { container } = render(
      <MessageAttachments mailboxId="mailbox-1" attachments={[attachment]} />,
    );

    expect(screen.getByTestId('message-attachment-filename')).toHaveTextContent(unsafeFilename);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain(sensitiveValues.uploadId);
    expect(container.innerHTML).not.toContain(sensitiveValues.objectKey);
    expect(container.innerHTML).not.toContain(sensitiveValues.bytes);
    expect(container.innerHTML).not.toContain(sensitiveValues.idempotencyKey);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
