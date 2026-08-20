# Skill: Implement Capability

Procedure for taking one capability from the ledger to accepted, reviewed, documented, and committed.

**Used by:** orchestrator (owns the procedure), implementer (executes steps 4–7).

---

## INPUT

- A capability ID and name from `docs/rebuild/capability-ledger.md` whose status is `Pending`.
- The current phase file in `docs/rebuild/08-roadmap/`.
- `docs/rebuild/execution-plan.md` when the capability is part of the recovery gate.

## PRECHECK

Abort and report if any is false:

- [ ] The capability's ledger dependencies are `Implemented` or `Verified`.
- [ ] The capability belongs to the current phase. (Phase N+1 work does not start while Phase N exit
      criteria are open.)
- [ ] `work/active/` holds no other capability, or holds one with disjoint file ownership.
- [ ] `git status` is clean, or its dirt is understood and intentional.
- [ ] The ledger active CAP, `work/active/` CAP, branch, and modified-file ownership agree.
- [ ] No unresolved BLOCKER in `work/reviews/` for a dependency.

---

## STEPS

### 1 — Establish ground truth

Read the capability's row in the ledger, its phase file, and the business rules it cites. List the
`R-*` rule IDs it must uphold. If the capability's scope is ambiguous in the docs, resolve that
first — an ambiguous contract produces two incompatible implementations.

### 2 — Write the contract

Create `work/active/CAP-NNN-slug/task.md` from `.claude/templates/capability-task.md`. It must contain:

- **Goal** — one sentence, in business terms.
- **Scope** / **Out of scope** — the second matters more; it is what prevents drift.
- **Business rules** — by ID, with what each means for this slice.
- **Acceptance criteria** — objectively checkable, no "works correctly". Each maps to a test or a
  demonstrable behaviour.
- **File ownership** — exact paths per agent. One writer per file.
- **Reading list** — the scoped doc set each subagent gets.
- **Reference implementation** — pinned repository/commit/files, adopt/adapt/reject decision, or
  an explicit `None`.
- **Delivery path** — how a user/runtime event reaches the slice, including assets, Worker
  entrypoint, binding/trigger, persistence, and visible result where applicable.

Skip the workspace only for a genuinely single-file capability requiring no delegation.

### 3 — Design the vertical slice

Name the layers this slice touches, in dependency order: domain → migration → repository → use case →
route → contract schema → client → tests. Confirm each new module edge against the dependency table
in `.claude/rules/architecture.md` *before* writing code. An edge not in that table needs the
orchestrator's decision, not the implementer's.

If an external reference is used, follow `.claude/rules/reference-implementations.md`. Pin the
commit, inspect the complete integration seam (application code plus build/runtime config), and
name the upstream assumptions that Unimailbox rejects.

### 4 — Implement

Follow `.claude/agents/implementer.md`. Thin and end-to-end beats thick and half-connected: a working
path through all layers is reviewable; a complete repository with no caller is not.

### 5 — Test

Per `.claude/rules/testing.md`. Minimum for any capability touching business behaviour:

- one test per `R-*` rule, named for the rule ID
- every state transition, legal and illegal
- one allowed and one denied case per authorization operation, plus an IDOR attempt
- idempotency replay (same key/body → same response; same key/different body → 409)
- at least one failure path

### 6 — Self-check

```
pnpm scaffold doctor && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:worker && pnpm build
```

Then re-read each acceptance criterion and confirm it individually. Then scan your own diff for the
legacy anti-patterns in `.claude/rules/architecture.md`.

For delivery-affecting work, also inspect the generated artifact and runtime configuration. A local
build does not prove that the Worker serves it; an exported queue/email handler does not prove that
Wrangler routes events to it. Run the contract's fresh-deploy/repeat-deploy or browser smoke gate.

### 7 — Implementer handoff

Report in the format in `.claude/agents/implementer.md`. Exact changed paths. Verbatim test results.
Assumptions stated. No commit.

### 8 — Review

Run `.claude/skills/review-capability/SKILL.md`. Reviewers must not have written the code. Run them
in parallel with each other, never alongside the implementer.

### 9 — Resolve

Fix every BLOCKER and HIGH. Record each deferred MEDIUM in the ledger with a reason — an unrecorded
deferral is a dropped finding. Re-run the gates after any fix.

### 10 — Persist repository memory

- Update the capability's ledger row: status, date, evidence, deferrals.
- Update `docs/rebuild/execution-plan.md` if sequencing, dependencies, or recovery boundaries changed.
- Append to `docs/rebuild/implementation-log.md`.
- Answer the documentation update gate (`.claude/rules/documentation.md`): did this invalidate a
  doc, add a business rule, add an architectural constraint, change the API contract, change the
  data model, or produce a lasting decision? Any yes → edit the owning document now.

### 11 — Clean up

Resolve every file in `work/active/CAP-NNN-*/` to PROMOTE, ARCHIVE, or DELETE. Remove the directory.
Empty `.tmp/` of this capability's leavings, having promoted anything that mattered.

### 12 — Commit

Per `.claude/rules/git.md`, and only if the user has asked for commits.

---

## VALIDATION

Do not mark the capability done unless every line is true:

- [ ] All acceptance criteria demonstrated, each with named evidence.
- [ ] Reference provenance and adaptation decisions recorded when an external implementation was used.
- [ ] Delivery path verified at the contract's required level: artifact, route, trigger, binding,
      migration, and browser/runtime behavior as applicable.
- [ ] All six quality gates pass, run and observed by the orchestrator.
- [ ] Architecture, code, and QA reviews complete; no open BLOCKER or HIGH.
- [ ] Every implemented `R-*` rule has a test named for it.
- [ ] Ledger and implementation log updated.
- [ ] Documentation update gate answered.
- [ ] `work/active/` cleaned; nothing new at the repository root.
- [ ] No secret, token, or message body in any log line.

---

## OUTPUT

```
Capability:  CAP-NNN — <name>
Status:      Implemented | Verified | Blocked
Phase:       <N>

Delivered:   <behaviour now available, in business terms>
Files:       <count and the significant paths>
Rules:       <R-* implemented>
Tests:       <counts by level, all passing>
Reviews:     <N blocker, N high, N medium — resolved or deferred>
Deferred:    <item → where recorded>
Docs:        <files updated>
Next:        CAP-NNN+1 — <name>
```
