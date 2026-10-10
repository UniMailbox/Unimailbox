// policy-evaluator.test.ts — D-CAP-021 / CAP-035 / CAP-036.
// Unit tests for the pure inbound evaluator. Tests are named after the
// rule IDs they prove (R-INBOUND-005 / R-INBOUND-006).
//
// CAP-036: the evaluator consumes hydrated `RolePolicy` objects. The
// factory below builds that shape, not the legacy JSON-row shape.

import { describe, expect, it } from 'vitest';
import type { BlocklistEntryRow, RolePolicy } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';
import { evaluateInboundPolicy } from './policy-evaluator';

function makeParsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: { address: 'sender@example.com', name: 'Sender' },
    to: [{ address: 'inbox@example.com', name: 'Inbox' }],
    cc: [],
    subject: 'Hello',
    messageId: '<test@message.id>',
    inReplyTo: null,
    references: '',
    htmlBody: '<p>Hello</p>',
    textBody: 'Hello',
    ...overrides,
  };
}

function blocklistEntry(kind: 'subject' | 'content' | 'from', pattern: string): BlocklistEntryRow {
  return {
    id: 'blocklist-id',
    kind,
    pattern,
    created_by: null,
    created_at: '2026-01-01 00:00:00',
  };
}

function policy(overrides: Partial<RolePolicy> = {}): RolePolicy {
  return {
    roleId: 'role-1',
    banEmail: [],
    availDomain: [],
    updatedBy: null,
    updatedAt: '2026-01-01 00:00:00',
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
    const decision = evaluateInboundPolicy(
      parsed,
      [],
      [blocklistEntry('subject', 'special offer')],
    );
    expect(decision.allow).toBe(false);
    if (decision.allow === true) throw new Error('expected rejection');
    expect(decision.reason).toContain('subject');
    expect(decision.reason).toContain('special offer');
  });

  it('rejects when content matches a blocklist entry', () => {
    const parsed = makeParsed({ textBody: 'Buy now, special offer!' });
    const decision = evaluateInboundPolicy(
      parsed,
      [],
      [blocklistEntry('content', 'special offer')],
    );
    expect(decision.allow).toBe(false);
    if (decision.allow === true) throw new Error('expected rejection');
    expect(decision.reason).toContain('content');
  });

  it('rejects when from matches a blocklist entry', () => {
    const parsed = makeParsed({ from: { address: 'spammer@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [], [blocklistEntry('from', 'evil.com')]);
    expect(decision.allow).toBe(false);
    if (decision.allow === true) throw new Error('expected rejection');
    expect(decision.reason).toContain('from');
  });

  it('blocklist wins over role policies (blocklist is checked first)', () => {
    const parsed = makeParsed({ from: { address: 'x@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(
      parsed,
      [policy({ availDomain: ['@evil.com'] })],
      [blocklistEntry('from', '@evil.com')],
    );
    expect(decision.allow).toBe(false);
  });
});

describe('evaluateInboundPolicy — R-INBOUND-006 (banEmail)', () => {
  it('rejects when a banEmail pattern matches an exact address', () => {
    const parsed = makeParsed({ from: { address: 'spammer@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(
      parsed,
      [policy({ banEmail: ['spammer@evil.com'] })],
      [],
    );
    expect(decision.allow).toBe(false);
  });

  it('rejects when a banEmail pattern matches a domain', () => {
    const parsed = makeParsed({ from: { address: 'anyone@evil.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [policy({ banEmail: ['@evil.com'] })], []);
    expect(decision.allow).toBe(false);
  });

  it('a wildcards banEmail rejects any sender', () => {
    const parsed = makeParsed({ from: { address: 'someone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [policy({ banEmail: ['*'] })], []);
    expect(decision.allow).toBe(false);
  });

  it('banEmail takes precedence over availDomain (Q2 of the contract)', () => {
    // The domain is on availDomain, but a wildcard ban still wins.
    const parsed = makeParsed({ from: { address: 'anyone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(
      parsed,
      [policy({ banEmail: ['*'], availDomain: ['@allowed.com'] })],
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
    const decision = evaluateInboundPolicy(parsed, [policy({ availDomain: ['@allowed.com'] })], []);
    expect(decision.allow).toBe(true);
  });

  it('rejects when sender domain is not on availDomain', () => {
    const parsed = makeParsed({ from: { address: 'someone@other.com', name: '' } });
    const decision = evaluateInboundPolicy(parsed, [policy({ availDomain: ['@allowed.com'] })], []);
    expect(decision.allow).toBe(false);
  });

  it('combines restrictively across multiple policies (each non-empty list must allow)', () => {
    // Two roles both impose non-empty availDomain. The sender must be on
    // BOTH lists. This is the AND-across-roles semantics.
    const parsed = makeParsed({ from: { address: 'someone@allowed.com', name: '' } });
    const decision = evaluateInboundPolicy(
      parsed,
      [
        policy({ roleId: 'role-a', availDomain: ['@allowed.com'] }),
        policy({ roleId: 'role-b', availDomain: ['@other.com'] }),
      ],
      [],
    );
    expect(decision.allow).toBe(false);
  });
});

describe('evaluateInboundPolicy — robustness', () => {
  // CAP-036: malformed JSON is no longer a concern — the cross-module
  // reader returns hydrated arrays, not raw rows. The closest analogue
  // is "empty patterns do not deny", which is already covered above. This
  // block now exercises the basic empty-input case only.
  it('evaluates a completely empty input set as allow', () => {
    const parsed = makeParsed();
    expect(evaluateInboundPolicy(parsed, [], []).allow).toBe(true);
  });
});
