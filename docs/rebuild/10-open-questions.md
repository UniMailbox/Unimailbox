# 10 — Open Questions

See `../J-risks-open-questions.md` for the full list with severities and recommended decisions. This document summarizes the **questions still requiring operator input** before Phase 1 implementation begins in the new repo.

## Questions blocking Phase 0

| # | Question | Default if no answer | Impact |
|---|---|---|---|
| Q1 | Is the deployment single-tenant (per deployment = one operator) or multi-tenant? | Single-tenant | Domain model |
| Q2 | Is LinuxDo OAuth actually used by any real user? | Drop in Phase 0 | Onboarding flow |
| Q3 | Is S3 backend used by any real deployment? | R2-only for Phase 1 | Storage layer |
| Q4 | What is the deployment topology during dual-run? | Separate cloud accounts | CI/CD |
| Q14 | Does anyone depend on `/oss/*` static file serving? | Keep, but auth-gate | Worker routes |
| Q15 | Are admin emails hardcoded into `wrangler.toml` in real deployments? | Assume none | Setup wizard |

## Questions blocking Phase 1

| # | Question | Default if no answer | Impact |
|---|---|---|---|
| Q5 | Is the new client built fresh in the new repo, or do we restart from the existing `mail-react/`? | **DECIDED**: fresh build in new repo | Frontend |
| Q6 | Should `from-name` be per mailbox or only per user? | Per-message | UI design |
| Q7 | Do we keep polling for inbox refresh, or move to push? | Polling 5s | UX |
| Q11 | Are we comfortable dropping LinuxDo OAuth? | Drop in Phase 0 | Onboarding flow |
| Q16 | What is the actual daily mail volume per deployment? | Plan for 1k/day | Capacity tests |

## Questions deferred to later phases

| # | Question | Phase | Default |
|---|---|---|---|
| Q9 | LinuxDo OAuth | 5 | Defer until user demand |
| Q10 | Per-role quota / ban / domain policy | 5 | Default allow |
| Q12 | Notification subsystem | 5 | Defer |
| Q13 | POP3/IMAP | separate workstream | Defer |
| Q17 | Custom R2 domain | 5 | Defer |

## Decision deadline

- **Q1, Q2, Q3, Q4** must be answered before Phase 0 starts.
- **Q11, Q14, Q15** must be answered before Phase 0 ends.
- **Q6, Q7, Q16** must be answered before Phase 1 starts.

## How to resolve

For each question:

1. Check legacy code for evidence (settings, env vars, runtime queries).
2. Check legacy access logs if available.
3. Ask the operator directly.
4. Document the answer in this file.

When a question is resolved, move it to `09-decisions/` as a new ADR.