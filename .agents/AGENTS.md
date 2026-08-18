# Agent Roles and Coordination

This file declares the agent roster that operates on the cf-startup (unimailbox)
repository and the protocol that the host (main Claude session) follows when
delegating to them.

It supplements the repository-wide rules in [../.rules/README.md](../.rules/README.md)
and the per-domain rules in [../.rules/](../.rules/) — every agent that picks
up work here must read `.rules/README.md` first and the per-domain file for the
area it touches (e.g. `.rules/frontend-platform.md` for `apps/web`).

## 1. Scope

These rules apply to:

- `.agents/` — this directory; the roster, scope, and constraints for every
  subagent that the host launches.
- The host's coordination behaviour: when to delegate, what artefacts each
  delegation must produce, what happens after an agent finishes.

These rules do **not** override per-domain rules. A migration-verification task
delegated to a general-purpose subagent still owes the assertions in
[../.rules/migrations.md](../.rules/migrations.md); a frontend refactor still
owes the dependencies and state-ownership boundaries in
[../.rules/frontend-platform.md](../.rules/frontend-platform.md).

## 2. Roster

| Subagent                              | Role                                             | Read | Write           | Verify |
| ------------------------------------- | ------------------------------------------------ | ---- | --------------- | ------ |
| [explorer](explorer.md)               | Read-only repository search                      | ✓    | ✗               | n/a    |
| [planner](planner.md)                 | Implementation planning (steps, risks, file map) | ✓    | ✗               | n/a    |
| [general-purpose](general-purpose.md) | Multi-purpose research + targeted code edits     | ✓    | ✓ (scoped)      | ✓      |
| [code-reviewer](code-reviewer.md)     | TS / change-quality review                       | ✓    | ✗ (advise only) | ✓      |
| [web-architect](web-architect.md)     | Frontend platform/architecture guidance          | ✓    | ✗ (advise only) | ✓      |

## 3. Coordination protocol

The host session is the only place that:

- Decides which subagent (or chain of subagents) is called for a user task.
- Issues the worktree in which the subagent operates (each agent must stay
  inside a single worktree branch for its lifetime).
- Reviews the artefacts the subagent produced before merging to `main`.
- Pushes the merged result to `origin/main` and updates
  [../docs/releases.md](../docs/releases.md) if the change ships.

The host **must not** directly edit application code, scripts, tests, or
configuration in the same worktree a subagent is using. Host edits to its own
worktree are reserved for coordination-only artefacts (memory, rules docs) that
no production code path depends on.

## 4. Delegation lifecycle

Every delegation follows the same five steps:

1. **Plan.** The host produces or reuses a plan that names the subagent,
   in-scope files, out-of-scope files, expected outputs, and the verification
   commands the subagent must run.
2. **Branch.** The host creates a fresh worktree (or reuses a long-lived one)
   for the delegation. The agent must not touch files outside the named set.
3. **Execute.** The subagent does the work, reports `git diff --stat`, and
   runs the verification commands listed in the host's plan.
4. **Review.** The host reads the subagent's report and patches, runs the
   verification commands again from a clean checkout, and only proceeds if
   everything is green.
5. **Land.** The host commits (or amends the subagent's commit), pushes the
   branch, fast-forwards `main`, and pushes `origin/main`.

## 5. Examples

### Toast / colour / password trio

- `explorer` scoped the three tasks into file lists and reported the
  contention between password-input and toast changes (both touched
  `LoginPage.tsx`). The host then negotiated non-overlapping scopes.
- Three `general-purpose` instances operated in parallel on disjoint file sets
  (toast branch, color branch, password branch) inside three worktrees.
- `code-reviewer` read each branch's diff, flagged one missing typecheck run,
  and confirmed the request-id no longer appeared in the DOM.

### Migration verify fix

- The host diagnosed the `Unknown argument` failure from the wrangler log,
  traced it to a leading `--` in the verify SQL file, and produced the rule
  plan in [../.rules/README.md](../.rules/README.md) before delegating.
- `general-purpose` rewrote `scripts/migration.mjs` to use `--file`, added
  `assertVerifySqlSafe`, replaced the 0009 verify SQL, and extended the test
  fixture.
- `code-reviewer` confirmed the query-core 4-arg `onSuccess`/`onError`
  signatures were correct against `node_modules/.../query-core/...d.ts` and
  flagged the misleading prior comment.
- The host committed, fast-forwarded `main`, pushed `origin/main`, and
  recorded the lesson in memory
  `migration-verify-sql-no-leading-dash-comment.md`.

## 6. Enforcement

- Direct `git add .` and broad `git commit -a` from a subagent are
  disallowed; subagents must stage only their own named files.
- Merges to `main` go through the host after a re-run of the verification
  commands; no subagent merges to `main` directly.
- Per-domain rules (`../.rules/*.md`) override the global ones when they
  conflict.
