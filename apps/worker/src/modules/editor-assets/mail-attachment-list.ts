import sanitizeHtml from 'sanitize-html';

export interface HostedMailFile {
  id: string;
  filename: string;
  sizeBytes: number;
  url: string;
}
const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Move only validated uploaded-file links to one footer after the domain signature. */
export function appendAttachmentList(
  html: string,
  text: string,
  files: readonly HostedMailFile[],
  large: boolean,
): { html: string; text: string } {
  if (!files.length) return { html, text };
  const unique = [...new Map(files.map((file) => [file.id, file])).values()];
  const ids = new Set(unique.map((file) => file.id));
  const labels = new Set<string>();
  const cleanHtml = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    exclusiveFilter: (frame) => {
      const match = frame.attribs['href']?.match(
        /\/api\/v1\/editor-assets\/([0-9a-f-]{36})\/[0-9a-f]{64}/,
      );
      if (frame.tag === 'a' && match?.[1] && ids.has(match[1])) {
        labels.add(frame.text.trim());
        return true;
      }
      return false;
    },
  });
  // The editor's plain alternative includes "label: URL" lines. Preserve unrelated links/images.
  const cleanText = text
    .split('\n')
    .map((line) =>
      line.replace(
        /https:\/\/[^\s<>"']+\/api\/v1\/editor-assets\/([0-9a-f-]{36})\/[0-9a-f]{64}/g,
        (url, id: string) => (ids.has(id) ? '' : url),
      ),
    )
    .filter(
      (line) =>
        !labels.has(line.trim()) && ![...labels].some((label) => line.trim() === label + ':'),
    )
    .join('\n')
    .trimEnd();
  const title = large ? '附件列表（超大附件）' : '附件列表';
  const size = (file: HostedMailFile): string =>
    file.sizeBytes < 1024
      ? `${file.sizeBytes} B`
      : file.sizeBytes < 1024 * 1024
        ? `${(file.sizeBytes / 1024).toFixed(2)} KiB`
        : `${(file.sizeBytes / 1024 / 1024).toFixed(2)} MiB`;
  return {
    html: `${cleanHtml}<div><br><strong>${title}</strong><ul>${unique.map((file) => `<li><a href="${escapeHtml(file.url)}">${escapeHtml(file.filename)}</a> (${size(file)})</li>`).join('')}</ul></div>`,
    text: `${cleanText}\n\n${title}\n${unique.map((file) => `- ${file.filename} (${size(file)}): ${file.url}`).join('\n')}`,
  };
}
