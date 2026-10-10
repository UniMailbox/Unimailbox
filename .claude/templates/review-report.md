# CAP-NNN — <architecture | code | qa | security | frontend> Review

> Location: `work/reviews/CAP-NNN-<dimension>-review.md`. Delete this block when filling in.

**Reviewer:** <role file> · **Date:** YYYY-MM-DD · **Base:** `<commit or branch>`

**Status:** ACCEPT · ACCEPT WITH FIXES · REJECT

## Summary

<Two or three sentences: is this sound, and what is the single most important thing to fix?
Do NOT summarize the diff — the orchestrator can read it.>

## Acceptance criteria — QA reviews only

| # | Criterion | Met | Evidence |
|---|---|---|---|
| 1 | <verbatim from task.md> | YES/NO | <test path or file:line> |

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

### B1 — <one-line claim>

- **Where:** `path/to/file.ts:42`
- **Violates:** `<R-XXX-NNN>` / `.claude/rules/<file>.md` §<section>
- **Failure scenario:** <concrete inputs or state → concrete wrong output. Not "could be unsafe".>
- **Fix:** <smallest correct change>

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

### H1 — <one-line claim>

- **Where:** · **Violates:** · **Failure scenario:** · **Fix:**

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

## LOW

> Style, naming, minor duplication. Fix if cheap.

## Not verified

<What you could not check, and why. An honest gap is more useful than a confident guess —
name it so the orchestrator can cover it another way.>

## Required fixes

1. B1 — <one line>
2. H1 — <one line>

---

Leave a severity section empty if it has no findings, and say so. An empty BLOCKER section is a
legitimate result; padding it with LOW-grade material to look thorough buries the real findings.
