// apps/worker/src/modules/inbound-mail/policy-evaluator.ts — D-CAP-021 / CAP-035.
// Pure inbound policy evaluator. R-INBOUND-005 + R-INBOUND-006.
//
// No I/O. The caller has already loaded:
// - the active blocklist entries (via BlocklistReader)
// - the parsed role_policy rows for the recipient mailbox owners' roles
//   (via RolePolicyReader)
//
// Evaluation order — per docs/rebuild/02-business-discovery/workflows.md W-4:
//   1. blocklist  (subject / content / from)         — R-INBOUND-005
//   2. per-role banEmail                             — R-INBOUND-006
//   3. per-role availDomain                          — R-INBOUND-006
//
// banEmail semantics: a matching ban from ANY recipient mailbox owner's
// role denies. banEmail takes precedence over availDomain: a `*` ban denies
// even if the domain is on availDomain (Decision §R-INBOUND-006).
//
// availDomain semantics: when MULTIPLE recipient mailbox owners' roles are
// in play (multiple recipient mailboxes), each role's availDomain list is
// evaluated INDEPENDENTLY. A non-empty availDomain list allows only senders
// whose domain is on that list. ALL such restrictions must pass — that is,
// the sender's domain must be allowed by every recipient owner's role that
// has configured a non-empty availDomain list. Roles with an empty
// availDomain list impose no restriction (BF-100).
//
// blocklist is GLOBAL — a single blocklist hit denies for every recipient.

import type { BlocklistEntryRow, RolePolicyRow } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';
import {
  matchesBlocklistEntry,
  matchesBanEmail,
  matchesAvailDomain,
} from './pattern-matchers';

export type EvaluationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/**
 * Evaluates the inbound policy for a single parsed email. Pure.
 *
 * @param parsed                  — The parsed RFC 5322 email (addresses pre-normalized per R-DATA-001)
 * @param rolePolicies            — Per-role policies for the recipient mailbox owners
 * @param blocklistEntries        — All active blocklist entries (global)
 * @returns                       — Either `{ allow: true }` or `{ allow: false, reason }`
 */
export function evaluateInboundPolicy(
  parsed: ParsedEmail,
  rolePolicies: ReadonlyArray<RolePolicyRow>,
  blocklistEntries: ReadonlyArray<BlocklistEntryRow>,
): EvaluationDecision {
  // 1. Blocklist — R-INBOUND-005. Any hit rejects.
  for (const entry of blocklistEntries) {
    if (matchesBlocklistEntry(parsed, entry)) {
      return {
        allow: false,
        reason: `Blocked by blocklist (${entry.kind}: ${entry.pattern})`,
      };
    }
  }

  // The downstream per-role policy checks use the sender's address
  // (parsed.from.address).
  const senderAddress = parsed.from.address;

  // Helper: parse the JSON pattern column. The repository already does this
  // for typed callers; here we walk the raw rows because the contract's
  // RolePolicyReader returns the raw storage row. Defensive parsing — a
  // malformed column is treated as "no patterns" so the message can still
  // pass under that role (and the failure is observable in storage).
  for (const policy of rolePolicies) {
    const banPatterns = safeParseStringArray(policy.ban_email_patterns_json);
    for (const pattern of banPatterns) {
      if (matchesBanEmail(pattern, senderAddress)) {
        return {
          allow: false,
          reason: `Sender banned by role policy (${pattern})`,
        };
      }
    }
  }

  // 3. availDomain — every non-empty list must allow. Roles with an empty
  // list impose no restriction.
  for (const policy of rolePolicies) {
    const availPatterns = safeParseStringArray(policy.avail_domain_patterns_json);
    if (availPatterns.length === 0) continue;

    const allowed = availPatterns.some((pattern) =>
      matchesAvailDomain(pattern, senderAddress),
    );
    if (!allowed) {
      return {
        allow: false,
        reason: 'Sender domain not in any role availDomain list',
      };
    }
  }

  return { allow: true };
}

function safeParseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}