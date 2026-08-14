// modules/inbound-mail — public API.
// D-CAP-021 / CAP-035: the module exports the inbound policy evaluator
// and pattern matchers. The atomic message-insert path lives in
// `entrypoints/inbound-email.ts` and depends on this module's evaluator.
//
// Architecture edge (this contract's Decision §Q1): inbound-mail reads
// admin-owned data (blocklist, role policies) through interfaces declared
// in `@unimailbox/contracts`. Implementations live in the admin module and
// are wired in `app-context.ts`. This file does not import from
// `modules/admin` directly.

export {
  evaluateInboundPolicy,
  type EvaluationDecision,
} from './policy-evaluator';

export {
  matchesBlocklistEntry,
  matchesBanEmail,
  matchesAvailDomain,
} from './pattern-matchers';