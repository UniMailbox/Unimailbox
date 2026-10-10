// apps/worker/src/modules/inbound-mail/policy-evaluator.ts — D-CAP-021 / CAP-035 / CAP-036.
// Pure inbound policy evaluator. R-INBOUND-005 + R-INBOUND-006.
//
// No I/O. The caller has already loaded:
// - the active blocklist entries (via BlocklistReader)
// - the hydrated role_policy objects for the recipient mailbox owners'
//   roles (via RolePolicyReader)
//
// CAP-036 / R-DATA-005: the reader returns hydrated `RolePolicy`
// objects — no JSON decoding happens here. The cross-module edge from
// inbound-mail to admin never exposes raw storage rows.
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

import type { BlocklistEntryRow, RolePolicy } from '@unimailbox/contracts';
import type { ParsedEmail } from '@unimailbox/email-core';
import { matchesBlocklistEntry, matchesBanEmail, matchesAvailDomain } from './pattern-matchers';

export type EvaluationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

/**
 * Evaluates the inbound policy for a single parsed email. Pure.
 *
 * @param parsed                  — The parsed RFC 5322 email (addresses pre-normalized per R-DATA-001)
 * @param rolePolicies            — Per-role hydrated policies for the recipient mailbox owners
 * @param blocklistEntries        — All active blocklist entries (global)
 * @returns                       — Either `{ allow: true }` or `{ allow: false, reason }`
 */
export function evaluateInboundPolicy(
  parsed: ParsedEmail,
  rolePolicies: ReadonlyArray<RolePolicy>,
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

  // 2. banEmail — R-INBOUND-006. A hit on ANY role denies.
  // CAP-036: the policy's patterns are already hydrated — no JSON
  // decoding happens here.
  for (const policy of rolePolicies) {
    for (const pattern of policy.banEmail) {
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
    if (policy.availDomain.length === 0) continue;

    const allowed = policy.availDomain.some((pattern) =>
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
