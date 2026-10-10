# Git Rules

## Branches

- `main` is always deployable. Do not commit directly to `main`.
- One branch per capability: `cap/CAP-014-process-withdrawal`.
- Other prefixes: `codex/` (Codex default), `fix/`, `docs/`, `chore/`, `inv/INV-004-...`.

## Commits

Conventional Commits. Use the capability ID for capability work; use a descriptive
scope such as `docs` or `security` for repository maintenance. Do not invent a CAP
ID merely to make a maintenance commit. The trail remains greppable:

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

- Commit/publish only within user authorization, including authorization retained
  from earlier turns. Delegated implementers leave changes for the main session.
- Use `JohnJiang <johnjiang@leanda.tech>` for both author and committer; verify before committing.
- Never `git add -A` blindly. Stage the files you actually changed and named in your report.
- Never amend or rebase a commit you did not create in this session. Never force-push a shared branch.
- Never commit with failing tests to "save progress". Use the handoff mechanism instead
  (`work/handoffs/`).
- A commit message describes the change, not the process. Nobody needs "as requested by the user".

## What is committed

**When changed and reviewed:** `CLAUDE.md`, shared `.claude` rules/hooks/roles, `docs/**`, source, migrations, tests, lockfile,
the capability ledger, the implementation log.

**Usually:** `work/active/*/task.md`, review reports with material findings, investigations that
produced a decision, useful handoffs.

**Never:** `.tmp/**`, `.env`/`.dev.vars`, secrets of any kind, `node_modules/`, build output, raw
logs, debug dumps, temporary screenshots, scratch scripts.

Keep personal Claude settings/memory, private recovery bundles, credentials and
raw acceptance data ignored. Follow `docs/operations/repository-hygiene.md`.

If an actual credential is found in Git, report its kind and location without its
value and arrange rotation/revocation first. Prepare cleanup without rewriting
shared history until explicitly authorized. A later deletion does not remove
published history; copies and forks may retain it.

## Capability completion

A capability's final commit lands only after: quality gates pass (`.claude/rules/testing.md`),
reviews are resolved, the ledger and implementation log are updated, and `work/active/CAP-NNN-*/`
has been cleaned up per `.claude/rules/documentation.md`.
