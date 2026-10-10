# Skill: Review Capability

Procedure for independently reviewing a finished capability before acceptance.

**Used by:** orchestrator (dispatches), reviewer subagents (execute).

---

## INPUT

- A capability with implementation reported COMPLETE.
- `work/active/CAP-NNN-slug/task.md`
- The diff (`git diff` against the capability's base commit).

## PRECHECK

Abort and report if any is false:

- [ ] The implementer has finished. **Never review a moving target.**
- [ ] `task.md` exists with acceptance criteria and business rules.
- [ ] The reviewer did **not** write this code. An agent reviewing itself reproduces its own blind
      spots — this is the single most important constraint in the procedure.
- [ ] The quality gates pass. If they do not, return to the implementer; do not spend review effort
      on code that does not compile.

---

## STEPS

### 1 — Dispatch (orchestrator)

Spawn in **parallel**, each with its own scoped brief:

| Reviewer | Role file | Always? |
|---|---|---|
| Architecture | `.claude/agents/architecture-reviewer.md` | Yes |
| Code | `.claude/agents/code-reviewer.md` | Yes |
| QA | `.claude/agents/qa-reviewer.md` | Yes, if the capability changes business behaviour |
| Security | `.claude/rules/security.md` as the brief | If it touches auth, secrets, credentials, webhooks, or user-supplied input reaching storage |
| Frontend | — | If it changes `apps/web/`. Check loading, error, empty, and success states; keyboard and focus behaviour; no store-as-event-bus |

Each brief contains: `task.md`, the diff, the role file, and the specific rules file. Not the whole
`docs/` tree.

### 2 — Review (each reviewer)

Work from your role file's checklist. The discipline that makes reviews worth their cost:

- **Challenge, do not summarize.** A review that describes what the code does has failed. The
  orchestrator can read the diff.
- **Construct the failure before reporting it.** Concrete inputs or state → concrete wrong output.
  If you cannot construct one, mark the finding PLAUSIBLE and state what you could not verify.
- **Check the absent, not just the present.** Missing denied-authorization test, missing failure
  path, missing audit event, missing idempotency handling. Absence is what diffs hide.
- **Anchor everything** at `file:line`, and cite the rule ID or doc it violates.
- **Stay in your lane.** Architecture ≠ code quality ≠ business behaviour. Overlap wastes three
  agents' effort on the same finding and leaves a gap elsewhere.

### 3 — Report (each reviewer)

Write `work/reviews/CAP-NNN-<dimension>-review.md` from `.claude/templates/review-report.md`.
Findings ranked most severe first. An empty BLOCKER/HIGH section is a legitimate result — say so
plainly rather than manufacturing filler.

### 4 — Triage (orchestrator)

Read all reports. For each finding:

- **Duplicate** across reviewers → merge, keep the clearest statement.
- **Disputed** → decide, and record the reasoning. If it constrains future work, it is an ADR.
- **BLOCKER / HIGH** → must be fixed before acceptance. Send back to the implementer with the
  specific finding, not the whole report.
- **MEDIUM** → fix now, or record in the ledger as a deferral with a reason. Never silently drop.
- **LOW** → fix if cheap; otherwise drop deliberately.

### 5 — Re-verify

After fixes, re-run the quality gates. If a fix touched a dimension materially, re-run that
reviewer — a fix under time pressure is exactly where the next defect enters.

---

## VALIDATION

- [ ] Every required dimension reviewed by an agent that did not write the code.
- [ ] Every finding has a file:line anchor and a concrete failure scenario.
- [ ] Every BLOCKER and HIGH resolved and re-verified.
- [ ] Every MEDIUM fixed or recorded in the ledger with a reason.
- [ ] Reviews with material findings archived; clean reviews deleted at capability close.

---

## OUTPUT

```
Capability:  CAP-NNN
Reviews:     architecture | code | qa | security | frontend
Verdict:     ACCEPT | ACCEPT WITH FIXES | REJECT

Findings:    N blocker, N high, N medium, N low
Resolved:    <what was fixed>
Deferred:    <what, why, where recorded>
Re-verified: <gates re-run after fixes: PASS/FAIL>
```
