// policy-evaluator.test.ts — D-CAP-021 / CAP-035.
// Unit tests for the pure inbound evaluator. Tests are named after the
// rule IDs they prove (R-INBOUND-005 / R-INBOUND-006).

import { describe, expect, it } from 'vitest';
import type { BlocklistEntryRow, RolePolicyRow } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';
import { evaluateInboundPolicy } from './policy-evaluator';

function makeParsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: { address: 'sender@example.com', name: 'Sender' },
    to: [{ address: 'inbox@example.com', name: 'Inbox' }],
    cc: [],
    subject: 'Hello',
    messageIdHeader: '<test@message.id>',
    inReplyToHeader: null,
    referencesHeader: '',
    htmlBody: '<p>Hello</p>',
    textBody: 'Hello',
    attachments: [],
    receivedAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function blocklistEntry(
  kind: 'subject' | 'content' | 'from',
  pattern: string,
): BlocklistEntryRow {
  return {
    id: 'blocklist-id',
    kind,
    pattern,
    created_by: null,
    created_at: '2026-01-01 00:00:00',
  };
}

function policy(overrides: Partial<RolePolicyRow> = {}): RolePolicyRow {
  return {
    role_id: 'role-1',
    ban_email_patterns_json: '[]',
    avail_domain_patterns_json: '[]',
    updated_by: null,
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('evaluateInboundPolicy — R-INBOUND-005 (blocklist)', () => {
  it('allows when blocklist is empty and no policies', () => {
    const parsed = makeParsed();
    const decision = evaluateInboundPolicy(parsed, [], []);
    expect(decision.allow).toBe(true);
  });

  it('rejects when subject matches a blocklist entry', () => {
    const parsed = makeParsed({ subject: 'SPECIAL OFFER' });
    const decision = evaluateInboundPolicy(parsed, [], [
      blocklistEntry('subject', 'special offer'),
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('subject');
    expect(decision.reason).toContain('special offer');
  });

  it('rejects when content matches a blocklist entry', () => {
    const parsed = makeParsed({ textBody: 'Buy now, special offer!' });
    const decision = evaluateInboundPolicy(parsed, [], [
      blocklistEntry('content', 'special offer'),
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('content');
  });

  it('rejects when from matches a blocklist entry', () => {
    const parsed = makeParsed({ from: { address: 'spammer@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [], [
      blocklistEntry('from', 'evil.com'),
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('from');
  });

  it('blocklist wins over role policies (blocklist is checked first)', () => {
    const parsed = makeParsed({ from: { address: 'x@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [policy({ avail_domain_patterns_json: '["@evil.com"]' })], [
      blocklistEntry('from', '@evil.com'),
    ]);
    expect(decision.allow).toBe(false);
  });
});

describe('evaluateInboundPolicy — R-INBOUND-006 (banEmail)', () => {
  it('rejects when a banEmail pattern matches an exact address', () => {
    const parsed = makeParsed({ from: { address: 'spammer@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [
      policy({ ban_email_patterns_json: '["spammer@evil.com"]' }),
    ], []);
    expect(decision.allow).toBe(false);
  });

  it('rejects when a banEmail pattern matches a domain', () => {
    const parsed = makeParsed({ from: { address: 'anyone@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [
      policy({ ban_email_patterns_json: '["@evil.com"]' }),
    ], []);
    expect(decision.allow).toBe(false);
  });

  it('a wildcards banEmail rejects any sender', () => {
    const parsed = makeParsed({ from: { address: 'someone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [
      policy({ ban_email_patterns_json: '["*"]' }),
    ], []);
    expect(decision.allow).toBe(false);
  });

  it('banEmail takes precedence over availDomain (Q2 of the contract)', () => {
    // The domain is on availDomain, but a wildcard ban still wins.
    const parsed = makeParsed({ from: { address: 'anyone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(
      parsed,
      [
        policy({
          ban_email_patterns_json: '["*"]',
          avail_domain_patterns_json: '["@allowed.com"]',
        }),
      ],
      [],
    );
    expect(decision.allow).toBe(false);
  });
});

describe('evaluateInboundPolicy — R-INBOUND-006 (availDomain)', () => {
  it('allows when availDomain is empty (BF-100 default)', () => {
    const parsed = makeParsed({ from: { address: 'anyone@anywhere.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [policy()], []);
    expect(decision.allow).toBe(true);
  });

  it('allows when sender domain is on availDomain', () => {
    const parsed = makeParsed({ from: { address: 'someone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [
      policy({ avail_domain_patterns_json: '["@allowed.com"]' }),
    ], []);
    expect(decision.allow).toBe(true);
  });

  it('rejects when sender domain is not on availDomain', () => {
    const parsed = makeParsed({ from: { address: 'someone@other.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [
      policy({ avail_domain_patterns_json: '["@allowed.com"]' }),
    ], []);
    expect(decision.allow).toBe(false);
  });

  it('combines restrictively across multiple policies (each non-empty list must allow)', () => {
    // Two roles both impose non-empty availDomain. The sender must be on
    // BOTH lists. This is the AND-across-roles semantics.
    const parsed = makeParsed({ from: { address: 'someone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(
      parsed,
      [
        policy({
          role_id: 'role-a',
          avail_domain_patterns_json: '["@allowed.com"]',
        }),
        policy({
          role_id: 'role-b',
          avail_domain_patterns_json: '["@other.com"]',
        }),
      ],
      [],
    );
    expect(decision.allow).toBe(false);
  });
});

describe('evaluateInboundPolicy — robustness', () => {
  it('treats malformed JSON as no patterns (fail-open at the policy level)', () => {
    const parsed = makeParsed({ from: { address: 'someone@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [
      policy({
        ban_email_patterns_json: 'not-valid-json',
        avail_domain_patterns_json: 'not-valid-json',
      }),
    ], []);
    expect(decision.allow).toBe(true);
  });

  it('evaluates a completely empty input set as allow', () => {
    const parsed = makeParsed();
    expect(evaluateInboundPolicy(parsed, [], []).allow).toBe(true);
  });
});
