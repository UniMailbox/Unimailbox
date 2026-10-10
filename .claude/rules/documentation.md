# Documentation Rules

## Classification — decide before you write

Every artifact an agent produces is exactly one of these. If you cannot classify it, it is Scratch.

| Class | Home | Lifetime | Committed |
|---|---|---|---|
| Permanent documentation | `docs/` | Indefinite; updated in place | Yes |
| Decision record (ADR) | `docs/rebuild/09-decisions/` | Indefinite; superseded, never deleted | Yes |
| Execution state | `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md` | Indefinite; append/update | Yes |
| Working artifact | `work/` | One capability | Usually |
| Scratch | `.tmp/` | One session | **Never** (gitignored) |

## Homes

- **`docs/rebuild/`** — the design specification. Already exists, already organised. **Do not move,
  rename, or restructure it.** When implementation contradicts it, edit the relevant file in place.
- **`docs/`** (outside `rebuild/`) — create a subdirectory only when there is real content for it
  (e.g. `docs/operations/` when the first runbook exists). Do not create empty directories.
- **`work/active/CAP-NNN-slug/`** — the shared workspace for a capability in flight. See `work/README.md`.
- **`work/reviews/`**, **`work/investigations/`**, **`work/handoffs/`**, **`work/archive/`**.
- **`.tmp/`** — raw command output, throwaway scripts, generated comparisons, debug artifacts.

## One fact, one home

Duplication is the failure mode this whole structure exists to prevent. A rule stated in five files
becomes five contradictory rules within a month.

| Fact | Single owner |
|---|---|
| Business rule / invariant | `docs/rebuild/02-business-discovery/business-rules.md` |
| Domain term | `docs/rebuild/02-business-discovery/business-glossary.md` |
| Architecture boundary | `docs/rebuild/05-target-architecture/` (enforced subset in `.claude/rules/architecture.md`) |
| Decision + rationale | an ADR |
| Agent behaviour rule | `.claude/rules/` |
| Delivery status | `docs/rebuild/capability-ledger.md` |

Everywhere else **links**. `CLAUDE.md` is navigation, not content.

## Promotion

Never write a guess into a permanent document.

```
observation (.tmp/ or work/notes.md)
  → investigation (work/investigations/INV-NNN-*.md)
    → verified → ADR or docs/  |  unverified → delete
```

If a conclusion in `.tmp/` turns out to matter, promote it before the session ends. **Reusable
project knowledge must never live only in `.tmp/`.**

## Lifecycle — no file stays UNKNOWN

At capability completion every file in `work/active/CAP-NNN-*/` must be resolved to one of:

- **PROMOTE** — merge into `docs/`, an ADR, the ledger, or the implementation log.
- **ARCHIVE** — move to `work/archive/YYYY-MM/CAP-NNN/` (audit value only).
- **DELETE** — no residual value.

Then remove the `work/active/` directory. `work/active/` contains only genuinely active work.

## Root directory

Forbidden at the repository root: `PLAN.md`, `NOTES.md`, `TODO*.md`, `RESULT.md`, `ANALYSIS.md`,
`REVIEW*.md`, `DEBUG.txt`, `SUMMARY.md`, and anything similar. Approved root files are `CLAUDE.md`,
`README.md`, and build/config files. Everything else belongs in a directory.

## Naming

`CAP-001` capabilities · `INV-001` investigations · `ADR-001` decisions. IDs are allocated in the
capability ledger and reused verbatim in directory names, review filenames, and commit messages so
that `grep CAP-014` finds the whole trail.

```
work/active/CAP-014-process-withdrawal/
work/reviews/CAP-014-security-review.md
work/investigations/INV-004-provider-retry-behavior.md
docs/rebuild/09-decisions/ADR-011-transaction-idempotency.md
```

## Documentation update gate

Before marking a capability done, answer these. Any "yes" means a doc edit is part of the capability,
not a follow-up:

- Did the implementation invalidate an existing doc?
- Did we add or change a business rule?
- Did we add or change an architectural constraint?
- Did the API contract change?
- Did the data model change?
- Did we make a decision future agents will depend on?

## Reports

Before writing a long report, ask what it is for:

- Permanent project knowledge → `docs/`
- Serves the current capability only → `work/`
- Only helped you think → `.tmp/`, and do not commit it

Keep the minimum quality evidence: acceptance criteria met, material review findings, the E2E
scenario, security findings. Do **not** commit full terminal logs, raw test output, or agent
transcripts — they have no long-term value and bury the signal.
