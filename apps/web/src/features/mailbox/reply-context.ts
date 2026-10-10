// apps/web — reply prefill context (CAP-044 Slice 1 / AC 5 + AC 6).
//
// D-CAP-044-C: the reply context is computed CLIENT-SIDE from the
// parent message's detail data. Pure function — no I/O, no hooks — so
// the threading invariant (AC 6) is unit-testable without a router or
// query cache.
//
// The rules:
//   - `to` is the parent's fromAddress (lower-cased + trimmed, R-DATA-001);
//   - `subject` is `Re: <parent.subject>` with NO double prefix when the
//     parent already starts with `re:` (case-insensitive);
//   - `inReplyTo` is the parent's messageIdHeader;
//   - `references` is the space-join of the threading base (parent
//     referencesHeader, or failing that parent inReplyToHeader, or '')
//     and the parent's messageIdHeader — so the reply's FIRST references
//     token is the parent's thread root under the CAP-043
//     THREAD_ROOT_SQL header tiers (references-first-token →
//     in-reply-to → own message-id), which is what makes the reply join
//     the parent's thread. Fix pass (a): the base tiers mirror the SQL
//     conditions exactly, not `||` truthiness — see containsTokenPair;
//   - when the parent has NO messageIdHeader — null OR empty string
//     (case d) — BOTH threading fields are omitted: a reply with no
//     parent message-id cannot be threaded server-side, so none is sent
//     (D-CAP-044-C).
import type { MessageDetail } from '@unimailbox/contracts';

/** Prefill values for the composer when replying to `parent`. */
export interface ReplyContext {
  /** Single-element array — the parent's sender. */
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  /** Parent's messageIdHeader. Absent when the parent has none (case d). */
  readonly inReplyTo?: string;
  /**
   * Space-joined `<...>` tokens. Absent when the parent has no
   * messageIdHeader (case d) — the reply then carries no threading
   * headers at all.
   */
  readonly references?: string;
}

/** True when `subject` already carries a reply prefix (`re:`, any case). */
function hasReplyPrefix(subject: string): boolean {
  return /^re:/i.test(subject);
}

/**
 * Fix pass (a) / AC 6 fidelity: THREAD_ROOT_SQL's references-tier guard,
 * mirrored exactly. The SQL is `instr('<') > 0 AND instr('>') >
 * instr('<')` — both instr calls find the FIRST occurrence overall, so
 * the JS mirror compares the first '>' overall against the first '<'
 * overall. A references value without a `<…>` pair (or with its first
 * '>' before its first '<', e.g. 'x> <a@b.c>') does NOT qualify and the
 * base falls through to inReplyToHeader.
 */
function containsTokenPair(value: string): boolean {
  const lt = value.indexOf('<');
  const gt = value.indexOf('>');
  return lt !== -1 && gt > lt;
}

export function buildReplyContext(parent: MessageDetail): ReplyContext {
  // R-DATA-001: addresses are compared and stored case-insensitively.
  const to = [parent.fromAddress.trim().toLowerCase()];
  const parentSubject = parent.subject.trim();
  const subject = hasReplyPrefix(parentSubject)
    ? parentSubject
    : parentSubject === ''
      ? 'Re:'
      : `Re: ${parentSubject}`;

  const messageIdHeader = parent.messageIdHeader;
  if (messageIdHeader === null || messageIdHeader === '') {
    // Case d: no parent message-id → no threading headers at all. Fix
    // pass (b): an EMPTY message-id behaves exactly like a missing one —
    // the SQL NULLIFs '' at its own tier for the same reason (an empty
    // root would fuse unrelated messages into one thread).
    return { to, subject };
  }

  // Fix pass (a): base selection mirrors the SQL tier conditions, not
  // truthiness. referencesHeader qualifies ONLY with a token pair
  // (containsTokenPair); the in_reply_to tier in the SQL accepts merely
  // non-null + non-empty — NO pair condition — so the JS base does too.
  const referencesBase = containsTokenPair(parent.referencesHeader)
    ? parent.referencesHeader
    : parent.inReplyToHeader !== null && parent.inReplyToHeader !== ''
      ? parent.inReplyToHeader
      : '';

  const references = [referencesBase, messageIdHeader]
    .filter((token) => token !== '')
    .join(' ')
    .trim();

  return { to, subject, inReplyTo: messageIdHeader, references };
}
