import sanitizeHtml from 'sanitize-html';

/** Parsed allowlist, shared by signatures and composed mail. Never embed data/blob images. */
export function sanitizeSignatureHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: [
      'p',
      'span',
      'h1',
      'h2',
      'h3',
      'div',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'a',
      'img',
      'blockquote',
    ],
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'alt', 'title'],
      p: ['style'],
      h1: ['style'],
      h2: ['style'],
      h3: ['style'],
      span: ['style'],
    },
    allowedStyles: {
      span: { 'font-size': [/^(12|14|16|18|24|32)px$/] },
      '*': {
        'margin-left': [/^(32|64|96|128|160)px$/],
        'text-align': [/^(left|center|right)$/],
        'line-height': [/^(1|1\.5|2)$/],
      },
    },
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'iframe',
      'object',
      'embed',
      'svg',
      'math',
      'template',
    ],
    exclusiveFilter: (frame) =>
      frame.tag === 'img' && !/^https:\/\//i.test(frame.attribs['src'] ?? ''),
  }).replace(/<br\s*\/>/g, '<br>');
}
