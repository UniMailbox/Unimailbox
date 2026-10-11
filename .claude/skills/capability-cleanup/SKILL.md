# Skill: Capability Cleanup

Use within the current user-authorized scope and the host's available tools.
Delegation is optional and requires authorization; without an independent agent,
record a self-check rather than claiming independent review. Current ledger state
and accepted decisions supersede historical phase sequencing.

Procedure for resolving the working artifacts a capability produced, before the next capability
starts. The point is to keep `work/` honest: every file resolves to one of PROMOTE, ARCHIVE, or
DELETE. Files left UNKNOWN are how repository memory rots.

**Used by:** Main Session, at capability close (after `.claude/skills/implement-capability/` step
11).

---

## INPUT

- A `work/active/CAP-NNN-slug/` directory with one or more files in it.
- The capability's `task.md` (for the context needed to judge each artifact's value).
- The implementation log entry written by the implementer (`docs/rebuild/implementation-log.md`).

## PRECHECK

- [ ] All architecture, code, QA, security (if applicable) reviews are resolved.
- [ ] All BLOCKER and HIGH findings are fixed.
- [ ] All MEDIUMs are either fixed or recorded in the ledger with a reason.
- [ ] The capability's quality gates are green.

If any precheck is false, abort and return to the implement-capability procedure.

## STEPS

### 1 — Enumerate every file in the workspace

List every file under `work/active/CAP-NNN-slug/`, including `.keep`, `.gitkeep`, and empty
files. For each, ask: what is this, and is it load-bearing for any future agent?

### 2 — Classify each file

For each file, pick exactly one:

- **PROMOTE** — the content is permanent project knowledge. Move it to:
  - `docs/` if it is a project-level artefact that future capabilities depend on
  - an ADR in `docs/rebuild/09-decisions/` if it is a decision with alternatives
  - `docs/rebuild/02-business-discovery/business-rules.md` if it is a business rule
  - `docs/rebuild/implementation-log.md` if it is a notable-but-local decision
- **ARCHIVE** — the content has audit value but no operational use. Move to
  `work/archive/YYYY-MM/CAP-NNN/<filename>`. Typical cases: a review with material findings, an
  investigation that produced a decision now in an ADR.
- **DELETE** — no residual value. This includes empty placeholders, scratch notes that did not
  lead anywhere, and tests' terminal output.

If you cannot classify a file, you have missed something; do not delete it.

### 3 — Update the ledger

For every PROMOTE, write the destination path into the capability's ledger row. For every
ARCHIVE, write the archive path. For every DELETE, no entry is needed — the file's absence is
the record.

### 4 — Update the implementation log

Append a one-line note to the capability's entry in
`docs/rebuild/implementation-log.md`: "Cleanup: 4 promoted, 1 archived, 2 deleted." This is what
makes "did we clean up" greppable.

### 5 — Remove the workspace

After every file has a destination, `rm -rf work/active/CAP-NNN-slug/`. Verify with
`ls work/active/` that nothing for this capability remains.

### 6 — Verify the documentation update gate

Run the gate from `.claude/rules/documentation.md`:

- Did this capability invalidate a doc?
- Did we add or change a business rule?
- Did we add or change an architectural constraint?
- Did the API contract change?
- Did the data model change?
- Did we make a decision future agents will depend on?

Any yes → the answer is a doc edit made during the capability, not now. If you find a yes here
that has no corresponding edit, the cleanup did not run before the implementation log entry was
written.

---

## VALIDATION

- [ ] Every file in the workspace classified to PROMOTE / ARCHIVE / DELETE.
- [ ] Every PROMOTE has its destination recorded in the ledger.
- [ ] Implementation log has the cleanup summary line.
- [ ] `work/active/CAP-NNN-slug/` is gone.
- [ ] Documentation update gate answered (every yes had a corresponding doc edit during the
      capability).

---

## OUTPUT

```
Capability:  CAP-NNN
Promoted:    <file → destination>  (one per line)
Archived:    <file → work/archive/YYYY-MM/CAP-NNN/>  (one per line)
Deleted:     <file>  (one per line)
Workspace:   removed
Log:         <one-line summary appended>
```