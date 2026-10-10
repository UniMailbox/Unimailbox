// apps/web — MessageAttachments tests.
// CAP-053/CAP-055: presentational attachment metadata, previews, and relative
// download controls.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { MessageDetail } from '@unimailbox/contracts';
import { MessageAttachments } from './MessageAttachments';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient, type ApiClient } from '../../infrastructure/api/client';

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

const inertClient = createApiClient({ baseUrl: '', getSessionToken: () => null });

function renderWithClient(ui: ReactElement, client: ApiClient = inertClient) {
  return render(ui, {
    wrapper: ({ children }) => <ApiClientProvider client={client}>{children}</ApiClientProvider>,
  });
}

describe('MessageAttachments', () => {
  it('R-ATTACHMENT-001/R-ATTACHMENT-006 preserves API order and builds encoded download links', () => {
    const mailboxId = 'mailbox/with space';
    const attachmentId = 'attachment/id?from=api';
    const attachments = [{ ...FIRST_ATTACHMENT, id: attachmentId }, SECOND_ATTACHMENT];

    renderWithClient(<MessageAttachments mailboxId={mailboxId} attachments={attachments} />);

    const rows = screen.getAllByTestId('message-attachment');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('first.txt');
    expect(rows[1]).toHaveTextContent('inline-image.png');
    expect(rows[0]).toHaveTextContent('42 B');
    expect(rows[1]).toHaveTextContent('1.5 KB');
    expect(rows[0]).toHaveTextContent('attachment');
    expect(rows[1]).toHaveTextContent('inline');

    const links = screen.getAllByTestId('message-attachment-download');
    expect(links[0]).toHaveAttribute('type', 'button');
    expect(links[0]).toHaveAccessibleName('Download first.txt');
    expect(links[1]).toHaveAttribute('type', 'button');
  });

  it('R-ATTACHMENT-001/R-ATTACHMENT-006 previews only allowed inline raster types and keeps every fallback downloadable', () => {
    const mailboxId = 'mailbox-preview';
    const allowedTypes = [
      'image/png',
      'image/jpeg; charset=binary',
      'IMAGE/GIF',
      'image/webp',
      'image/avif; profile=foo',
    ];
    const allowed = allowedTypes.map((contentType, index) => ({
      ...SECOND_ATTACHMENT,
      id: `00000000-0000-4000-8000-00000000010${index}`,
      filename: `allowed-${index}.img`,
      contentType,
    }));
    const fallback = [
      {
        ...SECOND_ATTACHMENT,
        id: '00000000-0000-4000-8000-000000000120',
        contentType: 'image/svg+xml',
        filename: 'vector.svg',
      },
      {
        ...SECOND_ATTACHMENT,
        id: '00000000-0000-4000-8000-000000000121',
        contentType: 'image/tiff',
        filename: 'photo.tiff',
      },
      {
        ...SECOND_ATTACHMENT,
        id: '00000000-0000-4000-8000-000000000122',
        contentType: 'image/png',
        disposition: 'attachment' as const,
        filename: 'ordinary.png',
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const urls = new Map(allowed.map((attachment) => [attachment.id, `blob:${attachment.id}`]));
    renderWithClient(
      <MessageAttachments
        mailboxId={mailboxId}
        attachments={[...allowed, ...fallback]}
        inlineImageUrls={urls}
      />,
    );

    const previews = screen.getAllByTestId('message-attachment-preview');
    expect(previews).toHaveLength(allowed.length);
    allowed.forEach((attachment, index) => {
      expect(previews[index]).toHaveAttribute('src', `blob:${attachment.id}`);
      expect(previews[index]).toHaveAttribute('alt', attachment.filename);
    });
    expect(screen.getAllByTestId('message-attachment-download')).toHaveLength(
      allowed.length + fallback.length,
    );
    expect(screen.getByText('vector.svg')).toBeInTheDocument();
    expect(screen.getByText('photo.tiff')).toBeInTheDocument();
    expect(screen.getByText('ordinary.png')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('R-API-001/R-API-002 handles empty and legacy attachment fields without throwing', () => {
    const { rerender } = renderWithClient(
      <MessageAttachments mailboxId="mailbox-1" attachments={[]} />,
    );
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

    const { container } = renderWithClient(
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

  it('downloads bytes through the authenticated API client instead of navigating to a Bearer-only URL', async () => {
    const requests: { path: string; authorization: string | null }[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const client = createApiClient({
      baseUrl: '',
      getSessionToken: () => 'memory-access-token',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          path: String(input),
          authorization: new Headers(init?.headers).get('Authorization'),
        });
        return new Response(bytes.buffer, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }) as typeof fetch,
    });
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:downloaded'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderWithClient(
        <MessageAttachments
          mailboxId="mailbox/1"
          attachments={[{ ...SECOND_ATTACHMENT, sizeBytes: 3 }]}
        />,
        client,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Download inline-image.png' }));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]).toEqual({
        path: `/api/v1/mailboxes/${encodeURIComponent('mailbox/1')}/attachments/${SECOND_ATTACHMENT.id}/download`,
        authorization: 'Bearer memory-access-token',
      });
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      click.mockRestore();
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});
