// Conservative signature HTML sanitizer — CAP-068.
// Workers do not expose a browser DOM. Rather than pretending a regex can
// understand arbitrary HTML, this parser accepts only a tiny, explicit token
// grammar and emits newly constructed markup. Unknown/dangerous tags and all
// attributes except safe link hrefs are discarded.

const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'a',
]);
const RAW_DANGEROUS_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
]);
const TOKEN_PATTERN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+|</g;

export function sanitizeSignatureHtml(input: string): string {
  let output = '';
  let skippedTag: string | null = null;

  for (const match of input.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;

    const closing = /^<\s*\/\s*([A-Za-z][A-Za-z0-9-]*)\s*>$/.exec(token);
    if (closing !== null) {
      const tag = closing[1]?.toLowerCase();
      if (tag === undefined) continue;
      if (skippedTag !== null) {
        if (tag === skippedTag) skippedTag = null;
        continue;
      }
      if (ALLOWED_TAGS.has(tag) && tag !== 'br') output += `</${tag}>`;
      continue;
    }

    const opening = /^<\s*([A-Za-z][A-Za-z0-9-]*)([\s\S]*?)\/?\s*>$/.exec(token);
    if (opening !== null) {
      const tag = opening[1]?.toLowerCase();
      if (tag === undefined) continue;
      if (skippedTag !== null) continue;
      if (RAW_DANGEROUS_TAGS.has(tag)) {
        skippedTag = tag;
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) continue;
      if (tag === 'br') {
        output += '<br>';
      } else if (tag === 'a') {
        output += renderAnchor(opening[2] ?? '');
      } else {
        output += `<${tag}>`;
      }
      continue;
    }

    if (skippedTag === null) output += escapeText(token);
  }

  return output;
}

function renderAnchor(rawAttributes: string): string {
  const attributes = rawAttributes.trim().replace(/\/$/, '').trim();
  if (attributes === '') return '<a>';

  // Read only the first href attribute. Any following attributes are
  // intentionally ignored rather than copied into the output.
  const href = /^href\s*=\s*(["'])([\s\S]*?)\1/i.exec(attributes)?.[2];
  if (href === undefined || !isSafeHref(href)) return '<a>';
  return `<a href="${escapeAttribute(href.trim())}">`;
}

function isSafeHref(href: string): boolean {
  if (
    [...href].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    return false;
  const normalized = href.trim().toLowerCase();
  return normalized.startsWith('https:') || normalized.startsWith('mailto:');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
