// apps/web — reply-context tests (CAP-044 Slice 1 / AC 5 + AC 6).
//
// AC 6 is the dedicated threading-invariant test: across the four
// parent shapes — (a) has references, (b) references empty + has
// in-reply-to, (c) neither (root), (d) messageIdHeader null — the
// constructed reply's `references` FIRST token equals the parent's
// resolved root under the CAP-043 THREAD_ROOT_SQL header tiers, or the
// reply carries no threading headers at all (case d).
//
// `resolvedThreadRoot` below mirrors the header tiers of
// apps/worker/src/modules/messages/message-read-repository.ts
// THREAD_ROOT_SQL (tier 1 `thread_id` aside — the client never sees it):
// first `<...>` token of references_header → in_reply_to_header → own
// message_id_header. The SQL is the authority; the mirror exists so a
// client-side change to buildReplyContext that breaks the invariant
// fails HERE even though the SQL lives in the worker.
import { describe, expect, it } from 'vitest';
import type { MessageDetail } from '@unimailbox/contracts';
import { buildReplyContext } from './reply-context';

function parentFixture(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: '00000000-0000-4000-8000-00000000000a',
    fromAddress: 'sender@example.com',
    fromName: 'Sender',
    subject: 'Original subject',
    htmlBody: '',
    textBody: 'body',
    messageIdHeader: '<mid-a@example.com>',
    inReplyToHeader: null,
    referencesHeader: '',
    status: 'delivered',
    isRead: 1,
    isStarred: 0,
    folder: 'inbox',
    createdAt: '2026-02-01T00:00:00Z',
    recipients: { to: [], cc: [] },
    ...overrides,
  };
}

/**
 * Mirror of THREAD_ROOT_SQL's header tiers (source:
 * apps/worker/src/modules/messages/message-read-repository.ts):
 *   1. first '<...>' token of references_header,
 *   2. in_reply_to_header (when non-null and non-empty),
 *   3. the message's own message_id_header (NULLIF '' — empty → null).
 *
 * Fix-pass note (criterion a): the SQL guard compares first-'>'-OVERALL
 * against first-'<'-overall (instr has no start offset), so 'x> <a@b.c>'
 * FAILS the references tier and falls to the next — the mirror below
 * reads indexOf('>') the same way, without a start index.
 */
function resolvedThreadRoot(parent: MessageDetail): string | null {
  const refs = parent.referencesHeader;
  const lt = refs.indexOf('<');
  const gt = refs.indexOf('>');
  if (lt !== -1 && gt > lt) {
    return refs.slice(lt, gt + 1);
  }
  if (parent.inReplyToHeader !== null && parent.inReplyToHeader !== '') {
    return parent.inReplyToHeader;
  }
  return parent.messageIdHeader !== '' ? parent.messageIdHeader : null;
}

describe('buildReplyContext — AC 6 threading invariant', () => {
  // Case (a): the parent carries a references header.
  const caseA = parentFixture({
    messageIdHeader: '<mid-c@example.com>',
    inReplyToHeader: '<mid-b@example.com>',
    referencesHeader: '<root@example.com> <mid-b@example.com>',
  });

  // Case (b): references empty, in-reply-to present.
  const caseB = parentFixture({
    messageIdHeader: '<mid-b@example.com>',
    inReplyToHeader: '<root@example.com>',
    referencesHeader: '',
  });

  // Case (c): neither — the parent is the thread root.
  const caseC = parentFixture({
    messageIdHeader: '<root@example.com>',
    inReplyToHeader: null,
    referencesHeader: '',
  });

  // Case (d): no messageIdHeader at all (references still present — the
  // hard variant: the reply must carry NO threading headers).
  const caseD = parentFixture({
    messageIdHeader: null,
    inReplyToHeader: '<root@example.com>',
    referencesHeader: '<root@example.com>',
  });

  it('(a) parent has references: reply references = parent references + parent message-id', () => {
    const ctx = buildReplyContext(caseA);
    expect(ctx.inReplyTo).toBe('<mid-c@example.com>');
    expect(ctx.references).toBe('<root@example.com> <mid-b@example.com> <mid-c@example.com>');
    const root = resolvedThreadRoot(caseA);
    expect(root).not.toBeNull();
    // INVARIANT: the reply's FIRST references token is the parent's
    // resolved root, so the reply joins the parent's thread.
    expect(ctx.references?.split(/\s+/)[0]).toBe(root as string);
  });

  it('(b) references empty + in-reply-to: reply references = parent in-reply-to + parent message-id', () => {
    const ctx = buildReplyContext(caseB);
    expect(ctx.inReplyTo).toBe('<mid-b@example.com>');
    expect(ctx.references).toBe('<root@example.com> <mid-b@example.com>');
    const root = resolvedThreadRoot(caseB);
    expect(root).not.toBeNull();
    expect(ctx.references?.split(/\s+/)[0]).toBe(root as string);
  });

  it('(c) root parent: reply references = the parent message-id alone', () => {
    const ctx = buildReplyContext(caseC);
    expect(ctx.inReplyTo).toBe('<root@example.com>');
    expect(ctx.references).toBe('<root@example.com>');
    const root = resolvedThreadRoot(caseC);
    expect(root).not.toBeNull();
    expect(ctx.references?.split(/\s+/)[0]).toBe(root as string);
  });

  it('(d) null messageIdHeader: BOTH threading fields are undefined, whatever the other headers hold', () => {
    const ctx = buildReplyContext(caseD);
    expect(ctx.inReplyTo).toBeUndefined();
    expect(ctx.references).toBeUndefined();
    // Both keys absent, not just undefined-valued — the composer sends
    // no threading headers at all.
    expect('inReplyTo' in ctx).toBe(false);
    expect('references' in ctx).toBe(false);
  });
});

// Fix pass (criterion a) — the malformed References class. `||` truthiness
// accepted a references header the SQL REJECTS: THREAD_ROOT_SQL uses
// references_header as the base ONLY when it contains a token pair
// (instr('<') > 0 AND instr('>') > instr('<')). Each case pairs the
// malformed references value with a resolvable inReplyToHeader, so the
// SQL root comes from the in-reply-to tier — the reply's references must
// follow it there.
describe('buildReplyContext — AC 6 malformed References (fix a)', () => {
  // Shared shape: mid + resolvable irt; only the malformed header varies.
  const malformedParent = (referencesHeader: string): MessageDetail =>
    parentFixture({
      messageIdHeader: '<mid-x@example.com>',
      inReplyToHeader: '<root@example.com>',
      referencesHeader,
    });

  const cases: ReadonlyArray<readonly [string, string]> = [
    ['plain text, no brackets', 'no brackets here'],
    ['whitespace only', '   '],
    ['lone open bracket', '<'],
    ['close bracket before any open bracket', '><'],
    // First-'>'-overall precedes the first '<' — the pair guard fails.
    ['stray early close bracket before a valid pair', 'x> <a@b.c>'],
  ];

  for (const [name, referencesHeader] of cases) {
    it(`(${name}) falls to the in-reply-to tier: the reply's first references token is the parent's resolved root`, () => {
      const parent = malformedParent(referencesHeader);
      const ctx = buildReplyContext(parent);
      expect(ctx.inReplyTo).toBe('<mid-x@example.com>');
      expect(ctx.references).toBe('<root@example.com> <mid-x@example.com>');
      const root = resolvedThreadRoot(parent);
      expect(root).not.toBeNull();
      // INVARIANT (AC 6): first references token = resolved root.
      expect(ctx.references?.split(/\s+/)[0]).toBe(root as string);
    });
  }
});

// Fix pass (criterion b): an EMPTY-string messageIdHeader must behave
// exactly like null (case d) — SQL tier 4 NULLIFs '' the same way, so a
// reply must never thread on an empty parent message-id.
describe('buildReplyContext — empty-string messageIdHeader (fix b)', () => {
  it("treats messageIdHeader === '' like null: no threading keys at all, whatever the other headers hold", () => {
    const parent = parentFixture({
      messageIdHeader: '',
      inReplyToHeader: '<irt@example.com>',
      referencesHeader: '<root@example.com>',
    });
    const ctx = buildReplyContext(parent);
    expect('inReplyTo' in ctx).toBe(false);
    expect('references' in ctx).toBe(false);
  });
});

describe('buildReplyContext — to / subject (AC 5, R-DATA-001)', () => {
  it('to is the single-element parent fromAddress, trimmed and lower-cased', () => {
    const ctx = buildReplyContext(
      parentFixture({ fromAddress: '  Sender@Example.COM ' }),
    );
    expect(ctx.to).toEqual(['sender@example.com']);
  });

  it('prefixes a plain subject with "Re: "', () => {
    expect(buildReplyContext(parentFixture({ subject: 'Quarterly report' })).subject).toBe(
      'Re: Quarterly report',
    );
  });

  it('does not double-prefix a subject that already starts with "Re:" (case-insensitive)', () => {
    expect(buildReplyContext(parentFixture({ subject: 'Re: already' })).subject).toBe('Re: already');
    expect(buildReplyContext(parentFixture({ subject: 'RE: shouted' })).subject).toBe('RE: shouted');
    expect(buildReplyContext(parentFixture({ subject: 're: lowercase' })).subject).toBe('re: lowercase');
  });

  it('does not treat a subject merely containing "re:" as already prefixed', () => {
    // "Store: re: inventory" does not START with re: — it gets a prefix.
    expect(buildReplyContext(parentFixture({ subject: 'files: re: inventory' })).subject).toBe(
      'Re: files: re: inventory',
    );
  });

  it('trims the parent subject before prefixing', () => {
    expect(buildReplyContext(parentFixture({ subject: '  padded  ' })).subject).toBe('Re: padded');
  });

  it('an empty parent subject still yields a non-empty reply subject', () => {
    expect(buildReplyContext(parentFixture({ subject: '' })).subject).toBe('Re:');
  });
});
