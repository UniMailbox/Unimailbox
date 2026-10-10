import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_UPLOAD_MAX_BYTES,
  attachmentContentTypeSchema,
  attachmentDispositionSchema,
  attachmentFilenameSchema,
  attachmentUploadDescriptorSchema,
} from './attachments';

describe('attachment upload contracts', () => {
  it('pins the temporary cap at exactly 5 MiB', () => {
    expect(ATTACHMENT_UPLOAD_MAX_BYTES).toBe(5_242_880);
  });

  it('accepts bounded filenames and media types', () => {
    expect(attachmentFilenameSchema.parse(' report.pdf ')).toBe('report.pdf');
    expect(attachmentContentTypeSchema.parse('application/pdf')).toBe('application/pdf');
    expect(attachmentContentTypeSchema.parse('text/plain; charset=utf-8')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(attachmentDispositionSchema.parse(undefined)).toBe('attachment');
    expect(attachmentDispositionSchema.parse('inline')).toBe('inline');
  });

  it('rejects unsafe or malformed metadata', () => {
    for (const filename of ['', '\0secret', 'line\nbreak', 'x'.repeat(256)]) {
      expect(attachmentFilenameSchema.safeParse(filename).success).toBe(false);
    }
    for (const contentType of ['', 'plain', 'text/plain\r\nX-Evil: yes']) {
      expect(attachmentContentTypeSchema.safeParse(contentType).success).toBe(false);
    }
  });

  it('keeps bytes out of the response descriptor', () => {
    const result = attachmentUploadDescriptorSchema.parse({
      uploadId: '00000000-0000-4000-8000-000000000001',
      mailboxId: '00000000-0000-4000-8000-000000000002',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      disposition: 'attachment',
      sizeBytes: ATTACHMENT_UPLOAD_MAX_BYTES,
      status: 'uploaded',
      expiresAt: '2026-08-28T01:00:00.000Z',
    });

    expect(result).not.toHaveProperty('bytes');
  });
});
