import DOMPurify, { type Config, type UponSanitizeElementHook } from 'dompurify';
import type { MessageDetail } from '@unimailbox/contracts';
import { isPreviewableInlineRaster, type MessageAttachment } from './message-attachment-media';

const ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
] as const;

const ALLOWED_ATTR = ['alt', 'height', 'href', 'rel', 'src', 'title', 'width'] as const;

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [...ALLOWED_TAGS],
  ALLOWED_ATTR: [...ALLOWED_ATTR],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|blob):|\/(?!\/)|[?#]|[^:\s])[\S]*$/i,
  FORBID_ATTR: ['style'],
  FORBID_TAGS: ['embed', 'form', 'iframe', 'object', 'script', 'style', 'svg'],
};

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const LINK_PROTOCOL_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export interface SanitizeMessageHtmlInput {
  readonly htmlBody: string;
  readonly attachments: MessageDetail['attachments'];
  /** Object URLs created from authorized binary fetches in this document. */
  readonly inlineImageUrls?: ReadonlyMap<string, string> | undefined;
}

/**
 * Sanitizes message HTML and resolves only known authorized inline raster CIDs.
 * DOMPurify owns HTML parsing. Its element hook applies the attachment and
 * link URL policy during the same sanitation walk, before the result can be
 * inserted into the live document.
 */
export function sanitizeMessageHtml({
  htmlBody,
  attachments,
  inlineImageUrls,
}: SanitizeMessageHtmlInput): string {
  const purifier = DOMPurify;
  const attachmentByContentId = indexInlineRasterAttachments(attachments);
  const rewrittenImages = new WeakSet<Element>();
  const applyUriPolicy = (element: Element): void => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === 'img') {
      if (rewrittenImages.has(element)) {
        return;
      }
      const source = element.getAttribute('src');
      if (source === null) {
        return;
      }
      const contentId = contentIdFromSource(source);
      const attachment = contentId === null ? undefined : attachmentByContentId.get(contentId);
      const objectUrl = attachment ? inlineImageUrls?.get(attachment.id) : undefined;
      if (objectUrl === undefined || !objectUrl.startsWith('blob:')) {
        element.removeAttribute('src');
      } else {
        element.setAttribute('src', objectUrl);
        rewrittenImages.add(element);
      }
    } else if (tagName === 'a') {
      const href = element.getAttribute('href');
      if (href !== null && !isSafeLinkHref(href)) {
        element.removeAttribute('href');
      }
    }
  };
  const uriPolicyHook: UponSanitizeElementHook = (currentNode) => {
    // DOMPurify sanitizes in an inert document, so the node may come from a
    // different realm than the app's global Element constructor.
    if (currentNode.nodeType !== 1) {
      return;
    }
    applyUriPolicy(currentNode as Element);
  };

  purifier.addHook('uponSanitizeElement', uriPolicyHook);
  try {
    if (!purifier.isSupported) {
      return '';
    }
    // DOMPurify's document parser can move a leading <img> into the head
    // and drop it. A body wrapper keeps top-level MIME content in place.
    const sanitizedFragment = purifier.sanitize(`<div>${htmlBody}</div>`, {
      ...SANITIZE_CONFIG,
      RETURN_DOM_FRAGMENT: true,
    }) as unknown as DocumentFragment;
    if (sanitizedFragment === null) {
      return '';
    }
    for (const node of Array.from(sanitizedFragment.childNodes)) {
      if (node.nodeType !== 1) {
        continue;
      }
      const element = node as Element;
      applyUriPolicy(element);
      for (const descendant of Array.from(element.querySelectorAll('img, a'))) {
        applyUriPolicy(descendant);
      }
    }
    const outputContainer = sanitizedFragment.ownerDocument.createElement('div');
    outputContainer.append(
      ...Array.from(sanitizedFragment.childNodes).map((node) => node.cloneNode(true)),
    );
    // The URI hook runs before the sanitized result can be inserted into the
    // live document, so no arbitrary image URL survives this boundary.
    return outputContainer.innerHTML;
  } finally {
    purifier.removeHook('uponSanitizeElement', uriPolicyHook);
  }
}

export function normalizeContentId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function indexInlineRasterAttachments(
  attachments: MessageDetail['attachments'],
): ReadonlyMap<string, MessageAttachment | null> {
  const byContentId = new Map<string, MessageAttachment | null>();
  for (const attachment of attachments ?? []) {
    if (!isPreviewableInlineRaster(attachment) || attachment.contentId === null) {
      continue;
    }
    const contentId = normalizeContentId(attachment.contentId);
    if (contentId === '') {
      continue;
    }
    if (byContentId.has(contentId)) {
      // A duplicate normalized CID is ambiguous; never choose an arbitrary
      // attachment when resolving an embedded resource.
      byContentId.set(contentId, null);
    } else {
      byContentId.set(contentId, attachment);
    }
  }
  return byContentId;
}

function contentIdFromSource(source: string | null): string | null {
  if (source === null) {
    return null;
  }
  const trimmed = source.trim();
  if (trimmed.length < 5 || trimmed.slice(0, 4).toLowerCase() !== 'cid:') {
    return null;
  }
  const contentId = normalizeContentId(trimmed.slice(4));
  return contentId === '' ? null : contentId;
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (
    trimmed === '' ||
    /^[\\/]{2}/.test(trimmed) ||
    trimmed.includes('\\') ||
    hasUnsafeUrlCharacters(trimmed)
  ) {
    return false;
  }

  const protocolMatch = trimmed.match(LINK_PROTOCOL_PATTERN);
  if (protocolMatch !== null) {
    const protocol = protocolMatch[0].toLowerCase();
    if (!SAFE_LINK_PROTOCOLS.has(protocol)) {
      return false;
    }
    if (protocol === 'mailto:') {
      return trimmed.length > protocol.length;
    }
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === protocol && parsed.host !== '';
    } catch {
      return false;
    }
  }

  // With no scheme and no protocol-relative prefix, the value is a relative
  // URL (including path, query, and fragment references).
  return true;
}

function hasUnsafeUrlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}
