// pattern-matchers.test.ts — D-CAP-021 / CAP-035.
// Unit tests for the pure pattern matchers. No I/O; pure inputs.

import { describe, expect, it } from 'vitest';
import type { BlocklistEntryRow } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';
import { matchesAvailDomain, matchesBanEmail, matchesBlocklistEntry } from './pattern-matchers';

function makeParsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: { address: 'sender@example.com', name: 'Sender' },
    to: [{ address: 'inbox@example.com', name: 'Inbox' }],
    cc: [],
    subject: 'Test subject',
    messageIdHeader: '<test@message.id>',
    inReplyToHeader: null,
    referencesHeader: '',
    htmlBody: '<html><body>HTML body</body></html>',
    textBody: 'Plain text body',
    attachments: [],
    receivedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function blocklistEntry(kind: 'subject' | 'content' | 'from', pattern: string): BlocklistEntryRow {
  return {
    id: 'test-id',
    kind,
    pattern,
    created_by: null,
    created_at: '2026-01-01 00:00:00',
  };
}

// ---------------------------------------------------------------------------
// R-INBOUND-005 — blocklist
// ---------------------------------------------------------------------------

describe('R-INBOUND-005 matchesBlocklistEntry', () => {
  it('matches subject substring case-insensitively', () => {
    // The pattern is expected to be pre-normalized (lowercased) by the
    // storage layer (admin-blocklist POST handler). The matcher
    // normalizes the parsed subject only.
    const parsed = makeParsed({ subject: 'Please review this URGENT matter' });
    expect(matchesBlocklistEntry(parsed, blocklistEntry('subject', 'urgent'))).toBe(true);
    expect(matchesBlocklistEntry(parsed, blocklistEntry('subject', 'frivolous'))).toBe(false);
  });

  it('matches content substring in text body', () => {
    const parsed = makeParsed({ textBody: 'Special offer for you today' });
    expect(matchesBlocklistEntry(parsed, blocklistEntry('content', 'special offer'))).toBe(true);
  });

  it('matches content substring in html body', () => {
    const parsed = makeParsed({ htmlBody: '<p>viagra prescription</p>' });
    expect(matchesBlocklistEntry(parsed, blocklistEntry('content', 'viagra'))).toBe(true);
  });

  it('matches from substring case-insensitively', () => {
    // The pattern is expected to be pre-normalized (lowercased) by the
    // storage layer (admin-blocklist POST handler). The matcher
    // normalizes the parsed `from.address` only.
    const parsed = makeParsed({
      from: { address: 'Spammer@EVIL.com', name: 'Spammer' },
    });
    expect(matchesBlocklistEntry(parsed, blocklistEntry('from', 'evil.com'))).toBe(true);
    expect(matchesBlocklistEntry(parsed, blocklistEntry('from', 'good.com'))).toBe(false);
  });

  it('returns false when no match anywhere', () => {
    const parsed = makeParsed({
      subject: 'Hello',
      textBody: 'World',
      htmlBody: '<p>Hello</p>',
      from: { address: 'alice@example.com', name: 'Alice' },
    });
    expect(matchesBlocklistEntry(parsed, blocklistEntry('subject', 'xxx'))).toBe(false);
    expect(matchesBlocklistEntry(parsed, blocklistEntry('content', 'xxx'))).toBe(false);
    expect(matchesBlocklistEntry(parsed, blocklistEntry('from', 'xxx'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R-INBOUND-006 — banEmail
// ---------------------------------------------------------------------------

describe('R-INBOUND-006 matchesBanEmail', () => {
  it('matches exact email case-insensitively', () => {
    expect(matchesBanEmail('spammer@example.com', 'spammer@example.com')).toBe(true);
    expect(matchesBanEmail('SPAMMER@example.com', 'spammer@EXAMPLE.com')).toBe(true);
    expect(matchesBanEmail('spammer@example.com', 'different@example.com')).toBe(false);
  });

  it('matches @domain when address is at the domain', () => {
    expect(matchesBanEmail('@evil.com', 'anyone@evil.com')).toBe(true);
    expect(matchesBanEmail('@evil.com', 'someone@sub.evil.com')).toBe(true);
    expect(matchesBanEmail('@evil.com', 'EVIL.com')).toBe(false);
    expect(matchesBanEmail('@evil.com', 'good@example.com')).toBe(false);
  });

  it('wildcard * matches any address', () => {
    expect(matchesBanEmail('*', 'anyone@anywhere.com')).toBe(true);
    expect(matchesBanEmail('*', 'a@b.c')).toBe(true);
    expect(matchesBanEmail('*', 'plain-string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R-INBOUND-006 — availDomain
// ---------------------------------------------------------------------------

describe('R-INBOUND-006 matchesAvailDomain', () => {
  it('matches @domain when address is at the domain', () => {
    expect(matchesAvailDomain('@allowed.com', 'someone@allowed.com')).toBe(true);
    expect(matchesAvailDomain('@allowed.com', 'abc@sub.allowed.com')).toBe(true);
    expect(matchesAvailDomain('@allowed.com', 'someone@other.com')).toBe(false);
  });

  it('matches deep subdomain (CAP-035 Code M4: availDomain covers any subdomain)', () => {
    // `@evil.com` rule — an address at a multi-level subdomain should match.
    expect(matchesAvailDomain('@evil.com', 'user@mail.deep.evil.com')).toBe(true);
    // But a domain that merely contains the suffix does not match
    // (`notevil.com` is a different domain, not a subdomain of `evil.com`).
    expect(matchesAvailDomain('@evil.com', 'user@notevil.com')).toBe(false);
  });

  it('does not match when address equals the pattern alone', () => {
    // The pattern "@allowed.com" is a domain suffix, not a full address.
    expect(matchesAvailDomain('@allowed.com', '@allowed.com')).toBe(false);
  });
});
