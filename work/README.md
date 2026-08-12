# Work Directory

Short-lived, multi-agent working artifacts. **Not** permanent documentation — that lives in `docs/`.
Classification rules: `.claude/rules/documentation.md`.

```
work/
├── active/          capability workspaces currently in flight
├── reviews/         review reports for capabilities not yet closed
├── investigations/  technical investigations (INV-NNN)
├── handoffs/        session / agent handoff notes
└── archive/         completed work retained for audit value, by YYYY-MM
```

## active/

One directory per in-flight capability: `work/active/CAP-NNN-slug/`.

```
CAP-014-process-withdrawal/
├── task.md        the contract — REQUIRED. From .claude/templates/capability-task.md
├── notes.md       shared working notes between agents (optional)
├── test-plan.md   scenarios beyond the unit suite (optional)
└── findings.md    open issues surfaced during implementation (optional)
```

`task.md` is the shared contract every subagent reads: goal, scope, out-of-scope, business rules,
acceptance criteria, file ownership. **Create only what is needed** — a single-file capability with
no delegation does not need a workspace at all, and empty placeholder files are worse than absent ones.

**WIP limit: one active capability**, unless file ownership is genuinely disjoint and the ledger
records why.

## reviews/

`CAP-NNN-{architecture,code,qa,security}-review.md`. Short and structured — status, findings by
severity, required fixes. Template: `.claude/templates/review-report.md`.

When the capability closes: reviews with material findings are archived; clean reviews are deleted.

## investigations/

`INV-NNN-topic.md` for technical questions that need answering before a decision.

Every investigation must terminate:

```
decision reached  → write an ADR or update docs/, then archive the investigation
no value          → delete
```

An investigation left open indefinitely is a leak. If it is still open at session end, it belongs in
the handoff as a blocker.

## handoffs/

`YYYY-MM-DD-slug.md` from `.claude/templates/handoff.md`. Write one when context is running low,
when a session ends mid-capability, or when handing to a different tool or model.

Keep it short: objective, done, current state, decisions, blockers, next concrete actions, relevant
files. **Never paste chat transcripts.** Delete a handoff once the next session has consumed it.

## archive/

`work/archive/YYYY-MM/CAP-NNN/`. Retained for audit value only.

Archive: acceptance evidence, material review findings, decisions not yet promoted to an ADR.
Do not archive: terminal logs, raw test output, agent transcripts, debug dumps.

## Cleanup contract

`work/` is not a second wastebasket. When a capability is done, the orchestrator resolves **every**
file in its workspace to PROMOTE, ARCHIVE, or DELETE, then removes `work/active/CAP-NNN-*/`.
No file stays in an unresolved state.

## Not here

Raw command output, throwaway scripts, generated comparisons, debug artifacts → `.tmp/`
(gitignored). If something in `.tmp/` turns out to matter, promote it before the session ends.
