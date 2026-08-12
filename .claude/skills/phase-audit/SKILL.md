# Skill: Phase Audit

Procedure for deciding whether a roadmap phase may close. Run once, at the end of each phase, by an
agent that did not implement the phase's capabilities.

The roadmap's governing rule: *"We do not move to the next phase until the current phase passes all
checks on a preview deployment."* This skill is how that rule is enforced rather than assumed.

---

## INPUT

- Phase number N.
- `docs/rebuild/08-roadmap/phase-N-*.md` — the exit criteria.
- `docs/rebuild/capability-ledger.md`.
- `docs/rebuild/implementation-log.md`.

## PRECHECK

- [ ] Every capability assigned to Phase N is `Implemented` or explicitly `Deferred` with a recorded
      reason.
- [ ] `work/active/` is empty.
- [ ] `work/reviews/` has no unresolved BLOCKER or HIGH.
- [ ] The auditor did not implement these capabilities.

---

## STEPS

### 1 — Enumerate the criteria verbatim

Copy every exit-criteria checkbox from the phase file into the audit report **as written**. Do not
paraphrase, do not merge, do not skip one that looks obviously satisfied. Paraphrasing a criterion
is how a criterion quietly stops being met.

### 2 — Verify each criterion independently

For each, record: **MET / NOT MET / UNVERIFIABLE**, plus the evidence. Evidence is a command you
ran and its output, a test path, or a `file:line`. "The implementer said so" is not evidence, and
neither is "the ledger says Implemented".

Where a criterion names a command, run the command. Where it names an HTTP behaviour, exercise it.
Where it names an end-to-end round trip, perform it on a preview deployment — Phase 1 in particular
requires a **real inbound email and a real reply**, not a simulated one.

Criteria of the form "no X exists in the codebase" (e.g. *"No use case imports a provider SDK
directly"*, *"No provider-specific code outside the integrations package"*) are verified by search
across the whole tree, not by inspecting the recent diff.

### 3 — Audit the invariants, not just the checkboxes

Independently of the phase list:

- Run the full quality gates from `.claude/rules/testing.md`.
- Walk the forbidden-dependency list in `.claude/rules/architecture.md` across the entire codebase.
- Walk the legacy anti-pattern list. Phase-boundary drift is where these reappear.
- Confirm no secret, token, or message body is logged anywhere.
- Confirm every state transition writes an audit event.

### 4 — Audit repository memory

Can a brand-new agent recover state from the repository alone (`CLAUDE.md` §State recovery)? Verify concretely:

- The ledger's statuses match reality.
- The implementation log covers the phase's work.
- Every decision made during the phase is in a rule, an ADR, or the log — not only in chat history.
- No stale `work/active/` leftovers, no orphaned investigations, no root-directory pollution.

### 5 — Verdict

**PASS** only if every criterion is MET. One NOT MET or UNVERIFIABLE means the phase does not close.

There is no partial pass. The value of a phase gate is entirely in its being unconditional; a phase
closed at 90% transfers the missing 10% into the next phase's foundations, which is exactly the
accretion this rebuild exists to undo.

### 6 — Record

Write `docs/rebuild/phase-N-audit.md` (permanent — it is the record that the gate was actually
enforced). Update the phase status in `docs/rebuild/capability-ledger.md` and the phase progress
table in `docs/rebuild/README.md`.

---

## VALIDATION

- [ ] Every exit criterion copied verbatim and individually verified.
- [ ] Every MET criterion has reproducible evidence.
- [ ] Quality gates run by the auditor, output observed.
- [ ] Architecture and anti-pattern sweeps run across the whole tree.
- [ ] Repository-recovery check performed.
- [ ] Verdict recorded; ledger and README updated.

---

## OUTPUT

```
Phase:    N — <title>
Verdict:  PASS | FAIL

Criteria: N met / N total
Not met:
  - <criterion verbatim> — <why, and what is required>

Sweeps:
  quality gates        PASS/FAIL
  dependency rules     PASS/FAIL — <violations>
  legacy anti-patterns PASS/FAIL — <instances>
  secret logging       PASS/FAIL
  audit coverage       PASS/FAIL

Repository memory: RECOVERABLE | GAPS — <what is missing>

Required before this phase can close:
  1. ...
```
