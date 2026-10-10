import { expect, it } from 'vitest';
import { appendAttachmentList } from './mail-attachment-list';
import {
  estimateEmailBytes,
  OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES,
} from '@unimailbox/contracts';
const id = '00000000-0000-4000-8000-000000000001';
const url = `https://mail.example/api/v1/editor-assets/${id}/${'a'.repeat(64)}`;
it('moves file links after the signature once in both alternatives without removing inline images or other links', () => {
  const file = { id, filename: '报告 <final>.pdf', sizeBytes: 12_000_000, url };
  const result = appendAttachmentList(
    `<p>Intro <a href="https://example.com">Website</a></p><p><a href="${url}">Upload</a></p><img src="https://images.example/logo.png"><p>Signature</p>`,
    `Intro\nUpload\nUpload: ${url}\nSignature`,
    [file, file],
    true,
  );
  expect(result.html.indexOf('附件列表（超大附件）')).toBeGreaterThan(
    result.html.indexOf('Signature'),
  );
  expect(result.text.indexOf('附件列表')).toBeGreaterThan(result.text.indexOf('Signature'));
  expect(result.html.split(url)).toHaveLength(2);
  expect(result.text.split(url)).toHaveLength(2);
  expect(result.html).toContain('报告 &lt;final&gt;.pdf');
  expect(result.html).toContain('<img src="https://images.example/logo.png"');
  expect(result.html).toContain('href="https://example.com"');
  expect(result.text).not.toContain('Upload');
});
it('labels regular hosted files and leaves mail without hosted files unchanged', () => {
  expect(appendAttachmentList('<p>Text</p>', 'Text', [], true)).toEqual({
    html: '<p>Text</p>',
    text: 'Text',
  });
  expect(
    appendAttachmentList(
      '<p>Text</p>',
      'Text',
      [{ id, filename: 'small.txt', sizeBytes: 1, url }],
      false,
    ).text,
  ).toContain('\n\n附件列表\n');
  expect(
    appendAttachmentList('', '', [{ id, filename: 'small.txt', sizeBytes: 3, url }], true).text,
  ).toContain('small.txt (3 B)');
});
it('counts encoded attachments and UTF-8 bodies against a decimal 10 MB threshold', () => {
  const body = '<p>签名</p>';
  expect(
    estimateEmailBytes(body, '正文', '标题', [5 * 1024 * 1024, 1 * 1024 * 1024]),
  ).toBeLessThanOrEqual(OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES);
  expect(
    estimateEmailBytes(body, '正文', '标题', [5 * 1024 * 1024, 3 * 1024 * 1024]),
  ).toBeGreaterThan(OUTBOUND_LARGE_ATTACHMENT_THRESHOLD_BYTES);
});
