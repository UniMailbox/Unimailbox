# Git Rules

## Branches

- `main` is always deployable. Do not commit directly to `main`.
- One branch per capability: `cap/CAP-014-process-withdrawal`.
- Other prefixes: `fix/`, `docs/`, `chore/`, `inv/INV-004-...`.

## Commits

Conventional Commits, with the capability ID in the scope so the trail is greppable:

```
feat(CAP-014): persist outbound job in the same D1 batch as the send

Send + outbound_jobs + idempotency_records now write in one batch so a crash
between them cannot produce a sent message with no job. Implements R-OUTBOUND-006.

Refs: docs/rebuild/09-decisions/ADR-003-durable-outbox.md
```

Types: `feat` `fix` `refactor` `test` `docs` `chore` `perf` `build`.

Granularity: one logical change per commit. A commit should build and pass tests on its own. Do not
mix a refactor with a behaviour change — a reviewer cannot separate them afterwards.

## Agent commit behaviour

- **Agents do not commit or push unless explicitly asked.** The orchestrator commits at capability
  boundaries; implementer subagents leave the working tree dirty and report changed files.
- Never `git add -A` blindly. Stage the files you actually changed and named in your report.
- Never amend or rebase a commit you did not create in this session. Never force-push a shared branch.
- Never commit with failing tests to "save progress". Use the handoff mechanism instead
  (`work/handoffs/`).
- A commit message describes the change, not the process. Nobody needs "as requested by the user".

## What is committed

**Always:** `CLAUDE.md`, `.claude/**`, `docs/**`, source, migrations, tests, lockfile,
the capability ledger, the implementation log.

**Usually:** `work/active/*/task.md`, review reports with material findings, investigations that
produced a decision, useful handoffs.

**Never:** `.tmp/**`, `.env`/`.dev.vars`, secrets of any kind, `node_modules/`, build output, raw
logs, debug dumps, temporary screenshots, scratch scripts.

If a secret is ever committed, stop: rotate the credential first, then purge the history. Removing
it in a later commit is not sufficient.

## Capability completion

A capability's final commit lands only after: quality gates pass (`.claude/rules/testing.md`),
reviews are resolved, the ledger and implementation log are updated, and `work/active/CAP-NNN-*/`
has been cleaned up per `.claude/rules/documentation.md`.
