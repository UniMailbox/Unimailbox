/**
 * @unimailbox/email-core
 *
 * Pure RFC 5322 functions. No I/O, no Date.now(), no crypto. Deterministic.
 *
 * CAP-021: Add MIME parsing for inbound mail.
 */
import PostalMime from 'postal-mime';

/**
 * Lowercases and trims an email address — R-DATA-001 (email addresses are
 * compared and stored case-insensitively). Pure: no I/O, no `Date.now()`,
 * no `crypto.randomUUID()`.
 */
export function normalizeAddress(input: string): string {
  return input.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// MIME parsing — CAP-021
// ---------------------------------------------------------------------------

/**
 * Parsed email representation — the output of parseEmail.
 *
 * Addresses are normalized per R-DATA-001 (lowercased).
 */
export interface ParsedEmail {
  readonly from: { address: string; name: string };
  readonly to: ReadonlyArray<{ address: string; name: string }>;
  readonly cc: ReadonlyArray<{ address: string; name: string }>;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: string;
}

export interface ParsedInboundAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly disposition: 'attachment' | 'inline';
  readonly contentId: string | null;
  readonly content: Uint8Array;
}

/** Decode nested MIME and transfer encodings from the original email bytes. */
export async function parseInboundMime(rawBytes: Uint8Array): Promise<{
  readonly parsed: ParsedEmail;
  readonly attachments: ReadonlyArray<ParsedInboundAttachment>;
}> {
  const email = await PostalMime.parse(rawBytes, { attachmentEncoding: 'arraybuffer' });
  const addresses = (entries: ReadonlyArray<{ address?: string; name: string }> | undefined) =>
    (entries ?? [])
      .filter((entry): entry is { address: string; name: string } => Boolean(entry.address))
      .map((entry) => ({ address: normalizeAddress(entry.address), name: entry.name ?? '' }));

  return {
    parsed: {
      from: {
        address: normalizeAddress(email.from.address ?? ''),
        name: email.from.name ?? '',
      },
      to: addresses(email.to),
      cc: addresses(email.cc),
      subject: email.subject ?? '',
      htmlBody: (email.html ?? '').trim(),
      textBody: (email.text ?? '').trim(),
      messageId: email.messageId || null,
      inReplyTo: email.inReplyTo || null,
      references: email.references ?? '',
    },
    attachments: email.attachments.map((attachment) => ({
      filename: attachment.filename || 'attachment',
      contentType: attachment.mimeType || 'application/octet-stream',
      disposition: attachment.disposition === 'inline' ? 'inline' : 'attachment',
      contentId: attachment.contentId?.replace(/^<|>$/g, '') || null,
      content:
        typeof attachment.content === 'string'
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content),
    })),
  };
}

/**
 * Result of parsing a single email address header (RFC 5322).
 * Handles "email@example.com" and "Display Name <email@example.com>".
 */
interface ParsedAddress {
  readonly address: string;
  readonly name: string;
}

/**
 * Parses a single RFC 5322 address string.
 * Handles:
 * - plain address: "user@example.com"
 * - with display name: "John Doe <user@example.com>"
 * - quoted display name: "\"John Doe\" <user@example.com>"
 *
 * Returns normalized (lowercased) address per R-DATA-001.
 */
function parseAddress(addr: string): ParsedAddress {
  const trimmed = addr.trim();

  // Check for angle bracket format: Display Name <address>
  const ltIdx = trimmed.lastIndexOf('<');
  const gtIdx = trimmed.lastIndexOf('>');

  if (ltIdx !== -1 && gtIdx !== -1 && ltIdx < gtIdx) {
    const address = trimmed.slice(ltIdx + 1, gtIdx).trim();
    const name = trimmed.slice(0, ltIdx).trim();
    // Remove quotes from display name if present
    const cleanName = name.replace(/^"(.*)"$/, '$1').trim();
    return { address: normalizeAddress(address), name: cleanName };
  }

  // Plain address without display name
  return { address: normalizeAddress(trimmed), name: '' };
}

/**
 * Parses an address list header (To, Cc).
 * Handles comma-separated RFC 5322 addresses.
 *
 * Example: "John Doe <john@example.com>, jane@example.com, "Bob" <bob@example.com>"
 */
function parseAddressList(list: string): ReadonlyArray<ParsedAddress> {
  if (!list.trim()) {
    return [];
  }

  // Split by commas, but not commas within quotes
  const addresses: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < list.length; i++) {
    const char = list[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === ',' && !inQuotes) {
      if (current.trim()) {
        addresses.push(current.trim());
      }
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    addresses.push(current.trim());
  }

  return addresses.map(parseAddress);
}

/**
 * Parses email headers from an RFC 5322 raw email.
 *
 * Headers are everything before the first blank line (CRLFCRLF or LFLF).
 * Returns a map of header name (lowercased) to value (unfolded).
 *
 * Header unfolding: RFC 5322 allows folding headers with CRLF + whitespace.
 * We unfold by replacing CRLF + whitespace with a single space.
 */
function parseHeaders(rawEmail: string): Map<string, string> {
  // Find the end of headers (first empty line)
  const headerEnd = rawEmail.search(/\r?\n\r?\n/);
  if (headerEnd === -1) {
    return new Map();
  }

  const headerSection = rawEmail.slice(0, headerEnd);
  const headers = new Map<string, string>();

  // Unfold folded headers (CRLF/LF + whitespace becomes space)
  const unfolded = headerSection.replace(/\r?\n[ \t]/g, ' ');

  // Split into individual header lines
  const lines = unfolded.split(/\r?\n/);

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const name = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers.set(name, value);
    }
  }

  return headers;
}

/**
 * Extracts the boundary from a Content-Type header for multipart messages.
 *
 * Example: "multipart/alternative; boundary=boundary123" → "boundary123"
 */
function getBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=([^;]+)/i);
  if (!match || !match[1]) return null;
  return match[1].trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Extracts text/plain and text/html parts from a multipart/* email body.
 *
 * Simple implementation for Phase 1:
 * - Splits on boundary="--{boundary}"
 * - For each part, parses headers and extracts body
 * - Returns text/plain and text/html if found
 *
 * Does NOT handle:
 * - Nested multipart
 * - Attached files
 * - Encoding other than plain text
 *
 * This is intentionally minimal — full MIME parsing can be added later.
 */
function extractMultipartParts(body: string, boundary: string): { text: string; html: string } {
  const parts = body.split(`--${boundary}`);
  let textBody = '';
  let htmlBody = '';

  for (const part of parts) {
    if (!part.includes('\r\n') && !part.includes('\n')) continue;
    if (part.trim() === '--' || part.trim() === `--${boundary}--`) continue;

    // Split part into headers and body
    const partHeaderEnd = part.search(/\r?\n\r?\n/);
    if (partHeaderEnd === -1) continue;

    const partHeaders = part.slice(0, partHeaderEnd);
    const partBody = part.slice(partHeaderEnd + 2).replace(/^\r?\n/, '');

    // Check Content-Type
    const contentTypeLower = partHeaders.toLowerCase();
    if (contentTypeLower.includes('content-type: text/plain')) {
      textBody = partBody.trim();
    } else if (contentTypeLower.includes('content-type: text/html')) {
      htmlBody = partBody.trim();
    }
  }

  return { text: textBody, html: htmlBody };
}

/**
 * Parses a raw RFC 5322 email string into structured data.
 *
 * This is a pure function — no I/O, no Date.now(), no crypto.
 * Deterministic for the same input.
 *
 * Handles:
 * - Basic headers (From, To, Cc, Subject, Message-ID, In-Reply-To, References)
 * - Simple multipart/alternative (text/plain + text/html)
 * - Address parsing with display names
 *
 * For Phase 1, this is intentionally minimal. Full MIME parsing
 * (nested parts, attachments, encoding) can be added later.
 *
 * @param rawEmail — The complete RFC 5322 email message as a string
 * @returns ParsedEmail with normalized addresses
 */
export async function parseEmail(rawEmail: string): Promise<ParsedEmail> {
  const headers = parseHeaders(rawEmail);

  // Extract From header (required)
  const fromHeader = headers.get('from') ?? '';
  const from = parseAddress(fromHeader);

  // Extract To, Cc headers (optional)
  const toHeader = headers.get('to') ?? '';
  const ccHeader = headers.get('cc') ?? '';
  const to = parseAddressList(toHeader);
  const cc = parseAddressList(ccHeader);

  // Extract Subject (optional, default empty)
  const subject = headers.get('subject') ?? '';

  // Extract Message-ID, In-Reply-To, References
  const messageId = headers.get('message-id') ?? null;
  const inReplyTo = headers.get('in-reply-to') ?? null;
  const references = headers.get('references') ?? '';

  // Find the body (after headers)
  const headerEnd = rawEmail.search(/\r?\n\r?\n/);
  let body = '';
  if (headerEnd !== -1) {
    body = rawEmail.slice(headerEnd + 2).replace(/^\r?\n/, '');
  }

  // Check for multipart
  const contentType = headers.get('content-type') ?? '';
  const boundary = getBoundary(contentType);

  let textBody = '';
  let htmlBody = '';

  if (boundary && contentType.toLowerCase().startsWith('multipart/')) {
    // Extract text and html from multipart
    const extracted = extractMultipartParts(body, boundary);
    textBody = extracted.text;
    htmlBody = extracted.html;
  } else {
    // Not multipart — assume plain text
    textBody = body.trim();
    htmlBody = '';
  }

  return {
    from,
    to,
    cc,
    subject,
    htmlBody,
    textBody,
    messageId,
    inReplyTo,
    references,
  };
}
