import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MessageDetail } from '@unimailbox/contracts';
import { SanitizedMessageHtml } from './SanitizedMessageHtml';
import { normalizeContentId, sanitizeMessageHtml } from './sanitize-message-html';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Attachment = NonNullable<MessageDetail['attachments']>[number];

const INLINE_ATTACHMENT: Attachment = {
  id: 'attachment/id?with space',
  filename: 'inline-logo.png',
  contentType: 'image/png; charset=binary',
  sizeBytes: 128,
  disposition: 'inline',
  contentId: ' <logo@example.test> ',
};

const ATTACHMENT_ONLY_IMAGE: Attachment = {
  ...INLINE_ATTACHMENT,
  id: 'ordinary-image',
  filename: 'ordinary.png',
  disposition: 'attachment',
  contentId: 'ordinary@example.test',
};

const MAILBOX_ID = 'mailbox/id?with space';

function parseSanitizedHtml(html: string): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('SanitizedMessageHtml', () => {
  it('R-ATTACHMENT-001/R-ATTACHMENT-006/R-ATTACHMENT-008 resolves only a normalized known inline raster CID', () => {
    const html = sanitizeMessageHtml({
      htmlBody: `
        <p>Before</p>
        <img src=" cid:<logo@example.test> " alt="logo" width="24" />
        <img src="cid:unknown@example.test" alt="unknown" />
        <img src="https://remote.example/logo.png" alt="remote" />
        <img src="cid:ordinary@example.test" alt="ordinary" />
      `,
      mailboxId: MAILBOX_ID,
      attachments: [INLINE_ATTACHMENT, ATTACHMENT_ONLY_IMAGE],
    });
    const container = parseSanitizedHtml(html);
    const images = [...container.querySelectorAll('img')];

    expect(images).toHaveLength(4);
    expect(images[0]).toHaveAttribute(
      'src',
      `/api/v1/mailboxes/${encodeURIComponent(MAILBOX_ID)}/attachments/${encodeURIComponent(INLINE_ATTACHMENT.id)}/download`,
    );
    expect(images[0]).toHaveAttribute('alt', 'logo');
    expect(images[0]).toHaveAttribute('width', '24');
    expect(images.slice(1).every((image) => !image.hasAttribute('src'))).toBe(true);
    expect(normalizeContentId('  <logo@example.test>  ')).toBe('logo@example.test');
    expect(normalizeContentId('<<logo@example.test>>')).toBe('<logo@example.test>');
  });

  it('R-ATTACHMENT-006/R-API-001 preserves safe structure and removes unsafe protocols', () => {
    const container = parseSanitizedHtml(
      sanitizeMessageHtml({
        htmlBody: `
          <h2 title="heading">Heading</h2>
          <p><strong>Safe</strong> <a href="https://safe.example/path" rel="noreferrer">link</a></p>
          <a href="/relative">relative</a>
          <a href="mailto:person@example.test">mail</a>
          <a href="javascript:alert(1)">bad-js</a>
          <a href="data:text/html,unsafe">bad-data</a>
          <a href="//remote.example/unsafe">bad-protocol-relative</a>
          <a href="ftp://remote.example/file">bad-ftp</a>
          <a href="\u0001javascript:alert(1)">bad-leading-control</a>
          <a href="java\tscript:alert(1)">bad-embedded-control</a>
          <a href="\\\\evil.example">bad-backslash-protocol-relative</a>
          <a href="/\\evil.example">bad-slash-backslash-protocol-relative</a>
          <a href="\\/evil.example">bad-backslash-slash-protocol-relative</a>
          <a href="https://safe.example/line\nfeed">bad-control</a>
          <a href="java\t\nscript:alert(1)">bad-obfuscated-js</a>
          <a href="java&#x09;script:alert(1)">bad-entity-js</a>
        `,
        mailboxId: 'mailbox-1',
        attachments: [],
      }),
    );

    expect(container.querySelector('h2')).toHaveAttribute('title', 'heading');
    expect(container.querySelector('strong')).toHaveTextContent('Safe');
    const safeLinks = [...container.querySelectorAll('a')];
    expect(
      safeLinks.some((link) => link.getAttribute('href') === 'https://safe.example/path'),
    ).toBe(true);
    expect(safeLinks.some((link) => link.getAttribute('href') === '/relative')).toBe(true);
    expect(
      safeLinks.some((link) => link.getAttribute('href') === 'mailto:person@example.test'),
    ).toBe(true);
    expect(container.querySelector('a[href^="javascript:"]')).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="data:"]')).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="//"]')).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="ftp:"]')).not.toBeInTheDocument();
    expect(
      safeLinks.some(
        (link) => link.textContent === 'bad-leading-control' && !link.hasAttribute('href'),
      ),
    ).toBe(true);
    expect(
      safeLinks.some(
        (link) => link.textContent === 'bad-embedded-control' && !link.hasAttribute('href'),
      ),
    ).toBe(true);
    for (const label of [
      'bad-leading-control',
      'bad-embedded-control',
      'bad-backslash-protocol-relative',
      'bad-slash-backslash-protocol-relative',
      'bad-backslash-slash-protocol-relative',
      'bad-control',
      'bad-obfuscated-js',
      'bad-entity-js',
    ]) {
      expect(
        safeLinks.some((link) => link.textContent === label && !link.hasAttribute('href')),
      ).toBe(true);
    }
    expect(container.querySelector('style')).not.toBeInTheDocument();
    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(container.querySelector('iframe')).not.toBeInTheDocument();
    expect(container.querySelector('object')).not.toBeInTheDocument();
    expect(container.querySelector('embed')).not.toBeInTheDocument();
    expect(container.querySelector('form')).not.toBeInTheDocument();
    expect(container.querySelector('[onclick]')).not.toBeInTheDocument();
    expect(container.querySelector('[style]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-secret]')).not.toBeInTheDocument();
  });

  it('R-API-001 preserves allowed descendants inside a non-allowlisted wrapper', () => {
    const container = parseSanitizedHtml(
      sanitizeMessageHtml({
        htmlBody: '<center><p>Wrapped safe text</p></center>',
        mailboxId: 'mailbox-1',
        attachments: [],
      }),
    );

    expect(container.querySelector('center')).not.toBeInTheDocument();
    expect(container.querySelector('p')).toHaveTextContent('Wrapped safe text');
  });

  it('R-ATTACHMENT-008 leaves duplicate normalized CIDs unresolved', () => {
    const duplicate = { ...INLINE_ATTACHMENT, id: 'different-attachment' };
    const container = parseSanitizedHtml(
      sanitizeMessageHtml({
        htmlBody: '<p><img src="cid:logo@example.test" alt="ambiguous" /></p>',
        mailboxId: 'mailbox-1',
        attachments: [INLINE_ATTACHMENT, duplicate],
      }),
    );

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image).not.toHaveAttribute('src');
  });

  it('R-API-001/R-SECRET-003 strips executable elements and event/style attributes', () => {
    const sanitized = sanitizeMessageHtml({
      htmlBody: `
        <p onclick="alert(1)" style="color: red" data-secret="nope">safe text</p>
        <script>alert('xss')</script>
        <style>body { display: none }</style>
        <svg><text>svg</text></svg>
        <iframe></iframe>
        <object data="https://remote.example/object"></object>
        <embed src="https://remote.example/embed" />
        <form><input value="nope" /></form>
      `,
      mailboxId: 'mailbox-1',
      attachments: [],
    });

    expect(sanitized).not.toMatch(/<(script|style|svg|iframe|object|embed|form)\b/i);
    expect(sanitized).not.toMatch(/\s(on[a-z]+|style|data-secret)=/i);
  });

  it('R-SECRET-003/R-LOG-001/R-ATTACHMENT-008 blocks external/data/blob images and performs no byte fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consoleSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const imageSrcSetterSpy = vi.spyOn(HTMLImageElement.prototype, 'src', 'set');
    const createObjectUrlSpy =
      typeof URL.createObjectURL === 'function' ? vi.spyOn(URL, 'createObjectURL') : undefined;
    const sensitiveValues = [
      'upload-secret-sentinel',
      'object-key-secret-sentinel',
      'attachment-bytes-secret-sentinel',
      'Idempotency-Key: secret-sentinel',
    ];
    const attachmentWithInternalValues = {
      ...INLINE_ATTACHMENT,
      uploadId: sensitiveValues[0],
      objectKey: sensitiveValues[1],
      bytes: sensitiveValues[2],
      idempotencyKey: sensitiveValues[3],
    } as Attachment;

    render(
      <SanitizedMessageHtml
        mailboxId="mailbox-1"
        htmlBody={`
          <img src="https://remote.example/remote.png" alt="remote" />
          <img src="data:image/png;base64,unsafe" alt="data" />
          <img src="blob:https://remote.example/blob" alt="blob" />
          <img src="cid:missing@example.test" alt="unknown" />
        `}
        attachments={[attachmentWithInternalValues]}
      />,
    );

    const images = screen.getByTestId('message-html-body').querySelectorAll('img');
    expect(images).toHaveLength(4);
    expect([...images].every((image) => !image.hasAttribute('src'))).toBe(true);
    expect(screen.getByTestId('message-html-body')).toHaveTextContent('');
    const renderedHtml = screen.getByTestId('message-html-body').innerHTML;
    for (const sensitiveValue of sensitiveValues) {
      expect(renderedHtml).not.toContain(sensitiveValue);
    }
    const consoleText = consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map(String).join(' '))
      .join('\n');
    for (const sensitiveValue of sensitiveValues) {
      expect(consoleText).not.toContain(sensitiveValue);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(imageSrcSetterSpy).not.toHaveBeenCalled();
    expect(createObjectUrlSpy?.mock.calls).toHaveLength(0);
  });
});
