// apps/worker/src/modules/inbound-mail/pattern-matchers.ts — D-CAP-021 / CAP-035.
// Pure pattern-matchers for R-INBOUND-005 (blocklist) and R-INBOUND-006
// (per-role policies). No I/O, no Date.now(), no crypto — they take strings
// only and return booleans.
//
// These are deliberately simple and synchronous. The inbound-email handler
// loads the relevant arrays once per message and walks them; with the
// expected scale (tens of entries, not thousands) this is the right shape.
//
// R-DATA-001: email addresses are compared case-insensitively. All inputs
// are expected to be pre-normalized (lowercased) by the caller — the
// matchers still lowercase defensively, but do not trim.

import type { BlocklistEntryRow } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';

// ---------------------------------------------------------------------------
// Blocklist — R-INBOUND-005
// ---------------------------------------------------------------------------

/**
 * Returns true when the given blocklist entry matches the parsed email.
 *
 * - kind = 'subject': case-insensitive substring against `parsed.subject`
 * - kind = 'content': case-insensitive substring against the concatenation
 *                    of `parsed.textBody` and `parsed.htmlBody`. A hit in
 *                    either body counts.
 * - kind = 'from':    case-insensitive substring against `parsed.from.address`
 *
 * Pattern is treated as a literal substring — no regex, no wildcards (v1).
 */
export function matchesBlocklistEntry(
  parsed: ParsedEmail,
  entry: BlocklistEntryRow,
): boolean {
  // CAP-035 Code M2: the route lowercases the pattern at storage time
  // (admin-blocklist POST handler), so this matcher must not lowercase
  // it again. The parsed sides are still normalized here because the
  // caller does not pre-normalize them.
  const pattern = entry.pattern;

  if (entry.kind === 'subject') {
    return parsed.subject.toLowerCase().includes(pattern);
  }

  if (entry.kind === 'from') {
    return parsed.from.address.toLowerCase().includes(pattern);
  }

  // kind === 'content'
  const text = parsed.textBody.toLowerCase();
  const html = parsed.htmlBody.toLowerCase();
  return text.includes(pattern) || html.includes(pattern);
}

// ---------------------------------------------------------------------------
// banEmail — R-INBOUND-006
// ---------------------------------------------------------------------------

/**
 * Returns true when the pattern denies the given email address. Three forms:
 *
 * - exact: "spammer@example.com" — match when the address equals this string
 * - domain: "@example.com" — match when the address is at this domain
 * - wildcard: "*" — match everything
 *
 * R-DATA-001: the comparison is case-insensitive.
 */
export function matchesBanEmail(pattern: string, address: string): boolean {
  const loweredPattern = pattern.toLowerCase();
  const loweredAddress = address.toLowerCase();

  if (loweredPattern === '*') {
    return true;
  }

  if (loweredPattern.startsWith('@')) {
    // Domain match — the address is at this domain OR any subdomain of it.
    // `@example.com` matches `anyone@example.com` and `user@mail.example.com`.
    // Strip the leading `@` from the pattern and require the address's
    // domain part (after the last `@`) to equal the pattern's domain, OR
    // end with `.` + pattern's domain (subdomain case). An address equal to
    // the pattern itself ("@example.com") is not a valid email and does
    // not match.
    const patternDomain = loweredPattern.slice(1); // "evil.com"
    const atIdx = loweredAddress.lastIndexOf('@');
    if (atIdx <= 0) return false;
    const addressDomain = loweredAddress.slice(atIdx + 1);
    return addressDomain === patternDomain || addressDomain.endsWith('.' + patternDomain);
  }

  // Exact email match.
  return loweredAddress === loweredPattern;
}

// ---------------------------------------------------------------------------
// availDomain — R-INBOUND-006
// ---------------------------------------------------------------------------

/**
 * Returns true when the pattern allows the given email address. One form:
 *
 * - domain: "@example.com" — match when the address is at this domain
 *
 * `pattern` is expected to be pre-validated (starts with `@`, lowercased).
 *
 * R-DATA-001: the comparison is case-insensitive.
 */
export function matchesAvailDomain(pattern: string, address: string): boolean {
  const loweredPattern = pattern.toLowerCase();
  const loweredAddress = address.toLowerCase();

  // CAP-035 Code M3: the `availDomainPatternSchema` enforces `^@` via
  // regex at the route boundary, so the leading `@` is guaranteed. Strip
  // it directly.
  // `@example.com` matches `anyone@example.com` and `user@mail.example.com`.
  // We compare the address's domain part (after the last `@`) against the
  // pattern's domain (with the leading `@` stripped) for an exact or
  // subdomain match. An address equal to the pattern itself is not a
  // valid email and does not match.
  const patternDomain = loweredPattern.slice(1);
  const atIdx = loweredAddress.lastIndexOf('@');
  if (atIdx <= 0) return false;
  const addressDomain = loweredAddress.slice(atIdx + 1);
  return addressDomain === patternDomain || addressDomain.endsWith('.' + patternDomain);
}