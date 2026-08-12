# CAP-002 — Code Review

**Reviewer:** `.claude/agents/code-reviewer.md` · **Date:** 2026-08-12 · **Base:** `e067d94` (working tree, branch `cap/CAP-001-monorepo-scaffold`)

**Status:** REJECT

## Summary

The harness runs and the code is clean at the statement level — no `any`, no `@ts-expect-error`, no
`Date.now()`/`sleep`/`console` in tests, no mocked D1/R2/KV, and `pnpm typecheck` / `pnpm lint` /
`pnpm test` are green (10 files, 34 tests). The defects are in the *wiring*, and they are the kind a
test harness cannot ship with: **`pnpm test:unit` — the command `.claude/rules/testing.md` §Quality
gates names as the gate — executes only 4 of the 10 test files.** The `contracts`, `email-core`,
`config`, `test-kit` and `web` projects are unreachable from either gate command. Fix B1 first;
everything else is downstream of it.

Secondary theme: the coverage configuration in `apps/worker/vitest.unit.config.ts` is entirely
inert (vitest 4 reads `coverage` from the root config only), and acceptance criterion #10's command
exits 1 because v8 coverage cannot load inside workerd. Both are reproduced below.

## BLOCKER

### B1 — `pnpm test:unit` skips 6 of the 10 test files, including two of the six the contract names

- **Where:** `package.json:20` (`"test:unit": "vitest run --project unit"`), `vitest.config.ts:10-18`
- **Violates:** `.claude/rules/testing.md` §Quality gates; task.md §Acceptance criteria #4
- **Failure scenario:** `--project unit` filters by project *name*. Only
  `apps/worker/vitest.unit.config.ts` is named `unit`; the other projects are named `contracts`,
  `email-core`, `config`, `test-kit`, `web`. Reproduced:

  ```
  $ pnpm test:unit      → Test Files 4 passed (4)   Tests 15 passed (15)
  $ pnpm test           → Test Files 10 passed (10) Tests 34 passed (34)
  ```

  The 15 are exactly `clock`(6) + `ids`(4) + `crypto`(1) + `errors`(4) from `apps/worker`.
  `packages/contracts/src/index.test.ts` and `packages/email-core/src/index.test.ts` — two of the six
  demonstrative unit files the contract enumerates — never run, and `pnpm test:worker` does not run
  them either. Concretely: delete `.toLowerCase()` from `emailAddressSchema`
  (`packages/contracts/src/index.ts:15`) and both quality-gate commands stay green while the
  R-DATA-001 test that exists to catch it sits unexecuted. Every `packages/*` test written from
  CAP-004 onward inherits this hole.
- **Fix:** `"test:unit": "vitest run --project '!workers'"`. Verified: 6 files, 24 tests, exit 0.
  Mirror the same change in `apps/worker/package.json:11` or delete those package-level scripts (see M5).

### B2 — The shared user fixture encodes a second source of authorization truth

- **Where:** `packages/test-kit/src/fixtures.ts:17` (`isAdministrator: boolean`), seeded at `:48`
- **Violates:** `.claude/rules/security.md` §Authorization (R-AUTHZ-005 — "Admin identity comes from
  the `administrator` role, never a hardcoded email list"); `.claude/rules/architecture.md`
  §Legacy anti-patterns ("Two parallel sources of authorization truth" — listed as a blocking finding)
- **Failure scenario:** `.claude/rules/architecture.md` §Persistence ownership puts admin identity in
  `roles` / `user_roles`, owned by the `admin` module; `users` is owned by `identity` and has no
  admin flag. This fixture is the *canonical* user builder — the contract's stated purpose is that
  no capability copy-pastes its own. CAP-019 (identity) writes
  `fixtures.user({ isAdministrator: true })`, gets a green test, and ships a `users.is_administrator`
  column plus the `administrator` role — two truths that will disagree the first time a role is
  revoked without touching the boolean. The fixture is where the divergence is cheapest to prevent
  and most expensive to discover.
- **Fix:** Delete `isAdministrator` from `UserRowShape` and from the builder. If tests need an admin
  actor before CAP-004 lands `user_roles`, add a separate `fixtures.userRole({ role: 'administrator' })`
  builder rather than a flag on the user row.

## HIGH

### H1 — Acceptance criterion #10's command exits 1; v8 coverage cannot run under workerd

- **Where:** `apps/worker/vitest.workers.config.ts` (no coverage provider configured); task.md
  §Acceptance criteria #10
- **Violates:** task.md §Acceptance criteria #10
- **Failure scenario:** Reproduced verbatim:

  ```
  $ pnpm exec vitest --project workers run --coverage --coverage.provider=v8
  ⎯ Test Run Error ⎯
  Error: No such module "node:inspector/promises".
    imported from ".../@vitest/coverage-v8/dist/index.js"
   Test Files  no tests
       Errors  8 errors
  $ echo $?
  1
  ```

  `@vitest/coverage-v8` needs `node:inspector/promises`, which workerd does not provide even with
  `nodejs_compat`. The criterion is not merely unmet — it is unachievable as written, so nobody can
  close it. It also means `apps/worker/src/platform/{database,cache}.ts` and the HTTP surface are
  outside any coverage measurement.
- **Fix:** Orchestrator decision. Either (a) set `coverage.provider: 'istanbul'` for the `workers`
  project only and add `@vitest/coverage-istanbul`, or (b) amend criterion #10 to measure coverage on
  the unit projects and record the workers project as intentionally unmeasured. Do not leave the
  criterion unticked with no note.

### H2 — The whole coverage block in `vitest.unit.config.ts` is dead configuration

- **Where:** `apps/worker/vitest.unit.config.ts:24-49`
- **Violates:** task.md §Scope ("Coverage threshold … `coverage.thresholds.lines = 70` for
  `apps/worker/src/platform/**` and `packages/email-core/**`"); `.claude/rules/coding.md` §Abstraction
  discipline (delete dead code)
- **Failure scenario:** In vitest 4 projects mode, `test.coverage` is honoured only in the root
  config; per-project coverage blocks are ignored. Reproduced with
  `pnpm exec vitest --project unit run --coverage --coverage.provider=v8`:
  - reporters actually emitted were the *defaults* — `coverage/base.css`, `clover.xml`,
    `coverage-final.json`, `*.html`. The configured `['text', 'json-summary']` did not apply;
    `coverage/coverage-summary.json` does not exist.
  - the per-file table printed **empty** and the summary read `6/6 statements` — only `crypto.ts` and
    `errors.ts` were measured. `src/platform/clock.ts` and `ids.ts` are in the configured `include`
    and were not counted, confirming `include` was ignored.

  Three separate bugs are hidden inside the dead block, all of which surface the moment someone moves
  it to the root config to make it live:
  1. `:29` — `'../../../packages/email-core/src/**/*.ts'`. From `apps/worker`, `../../` is the repo
     root, so `../../../` resolves to `/Users/john/Workspace/x/packages/email-core` — outside the
     repository. `packages/email-core/**` would silently measure nothing.
  2. `:40-47` — `thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 }` under a
     comment reading "Record-only — the build must not fail on these numbers." Vitest thresholds do
     exactly the opposite: they fail the run when unmet. It passes today only because the include
     glob is inert and the two measured files happen to be 100%. Live it, add one uncovered line, and
     the build hard-fails.
  3. The contract asks for `lines = 70`, not 100.
- **Fix:** Move a single `coverage` block to the root `vitest.config.ts`, set
  `thresholds.lines = 70` (drop the other three), and correct the email-core path to
  `packages/email-core/src/**/*.ts` (root-relative). Delete the block from the project config.

### H3 — `@unimailbox/test-kit` is importable from `apps/worker` only

- **Where:** `packages/email-core/package.json`, `packages/config/package.json`,
  `apps/web/package.json` — none declare `@unimailbox/test-kit`
- **Violates:** task.md §Acceptance criteria #11 ("importable from **any** workspace package without
  a circular dependency")
- **Failure scenario:** Reproduced — a test file in `packages/contracts/src/` importing
  `stubFetch` fails at runtime:

  ```
  FAIL |contracts| src/__urltrap.test.ts
  Error: Cannot find package '@unimailbox/test-kit' imported from .../packages/contracts/src/...
  ```

  CAP-021's `email-core` tests will need `fixtures`/`fakeClock`, hit this, and either add the dep
  ad hoc or copy-paste the fixture — the precise outcome `.claude/rules/testing.md` §Mocking
  ("Fixtures and builders live in `packages/test-kit/`, not copy-pasted per test file") forbids.
  Note the criterion as written cannot be fully met: `test-kit` depends on `@unimailbox/contracts`
  (`packages/test-kit/package.json`), so `contracts` importing `test-kit` is a genuine cycle.
- **Fix:** Add `"@unimailbox/test-kit": "workspace:*"` to `devDependencies` of `packages/email-core`,
  `packages/config` and `apps/web`. Amend criterion #11 to exclude `packages/contracts` and record
  why (cycle), so the exception is a decision rather than an oversight.

### H4 — `router.test.ts` passes a `Fetcher` where the worker `Env` is expected

- **Where:** `apps/worker/src/http/router.test.ts:16` and `:28` — `SELF as unknown as Env`
- **Violates:** `.claude/agents/code-reviewer.md` §Type safety ("`as` used to silence rather than to
  narrow"); `.claude/rules/testing.md` §Mocking (the worker project exists to run against *real*
  bindings)
- **Failure scenario:** `SELF` from `cloudflare:test` is a `Fetcher` service binding — it has a
  `fetch` method and nothing else. It is not the `Env` declared at
  `apps/worker/src/platform/env.ts:8`, and the double cast is the only reason this compiles. The app
  therefore executes with an env object that has no `DB`, `CACHE`, `ATTACHMENTS` or `OUTBOUND`. It
  passes today solely because `/healthz` reads nothing from env. When CAP-006 adds the setup-gate
  middleware (`installation_state.status !== 'complete'` → 302), that middleware calls
  `getDatabase(env)` → `env.DB` → `undefined` → `TypeError: Cannot read properties of undefined
  (reading 'prepare')`, and the CAP-006 author debugs their middleware instead of the harness.
  The sibling tests get this right: `database.test.ts:5` and `cache.test.ts:3` import `env` from
  `cloudflare:test`. The test's own title — "via SELF" — describes something the code does not do.
- **Fix:** Either `import { env } from 'cloudflare:test'` and pass `env as unknown as Env` for
  consistency with the sibling tests, or drop `app.fetch` and use
  `await SELF.fetch('http://localhost/healthz')`, which exercises the real deployed entrypoint with
  the real bindings and needs no cast at all. The second is the better demonstration of what the pool
  is for.

## MEDIUM

### M1 — Two hand-maintained lists of the same four file paths

- **Where:** `apps/worker/vitest.unit.config.ts:16-19` (exclude) and
  `apps/worker/vitest.workers.config.ts:19-22` (include)
- **Failure scenario:** CAP-004 adds `src/platform/object-store.test.ts` needing the R2 binding. The
  author adds it to the `workers` include and forgets the `unit` exclude. The file now runs in both
  projects; under the node pool `import { env } from 'cloudflare:test'` is unresolvable and
  `pnpm test:unit` dies with a module-resolution error that names neither the config nor the cause.
- **Fix:** Switch to a filename convention — `*.worker.test.ts` for pool tests — and make the two
  configs `include: ['src/**/*.worker.test.ts']` / `exclude: ['src/**/*.worker.test.ts']`. One rule,
  no list to forget.

### M2 — `crypto.test.ts` asserts the module is empty and will fail the moment it is not

- **Where:** `apps/worker/src/platform/crypto.test.ts:13-15`
- **Failure scenario:** `expect(typeof mod).toBe('object')` is vacuously true for any ES module
  namespace. `expect(Object.keys(mod)).toEqual([])` asserts that `platform/crypto.ts` exports
  nothing — so CAP-010's first line of real work (`export async function hashPassword(...)`) turns
  this green test red for the correct change, and the CAP-010 author must delete a passing test to
  proceed. Per `.claude/agents/code-reviewer.md` §Tests, this asserts that nothing threw, not
  behaviour.
- **Fix:** Delete the file. `crypto.ts` has no behaviour to test until CAP-010; an empty file name is
  not worth reserving. If the import-cleanliness signal is genuinely wanted, keep only
  `await expect(import('./crypto')).resolves.toBeDefined()`.

### M3 — `RecordedSend.at` holds a call index, not a time

- **Where:** `packages/test-kit/src/stubs.ts:25` (declaration) and `:46` (`at: calls.length`)
- **Failure scenario:** The field name and the `number` type both read as a timestamp. CAP-023 writes
  `expect(adapter.calls[0].at).toBe(clock.unixMs())` against a `fakeClock` seeded to
  `2026-01-01T00:00:00Z` and gets `0`, or worse writes
  `expect(calls[1].at - calls[0].at).toBeLessThan(1000)` and gets a meaningless `1` that passes for
  the wrong reason. There is no clock in the stub at all, so it cannot record a real time.
- **Fix:** Rename to `sequence`, or take an optional `clock: { unixMs(): number }` parameter on
  `stubOutboundAdapter` and record `clock.unixMs()`. The rename is smaller and honest.

### M4 — `stubFetch` matches URLs by exact string, so `Request` normalisation misses

- **Where:** `packages/test-kit/src/stubs.ts:106-109`
- **Failure scenario:** `Request` normalises its URL. Verified in node:
  `new Request('http://x').url === 'http://x/'`. So
  `f.on('http://x', 200); await f(new Request('http://x'))` throws
  `stubFetch: no handler registered for URL http://x/` — a registered handler that never fires. The
  same trap catches any query-string or trailing-slash difference between registration and call.
  The failure mode is a thrown error rather than a wrong answer, which is the right *direction* —
  but the error blames the caller for a mismatch the stub created.
- **Fix:** Normalise both sides through `new URL(...).toString()` before `set` and `get`. Keep the
  throw-on-unregistered behaviour; it is correct and well-reasoned.

### M5 — `apps/worker`'s own test scripts crash when run from the package directory

- **Where:** `apps/worker/package.json:10-12`; root cause `vitest.config.ts:11-17`
- **Failure scenario:** The root config's `projects` entries are relative strings, which vitest
  resolves against the **cwd**, not the config file's directory. Reproduced:

  ```
  $ pnpm --filter @unimailbox/worker run test:worker
  Error: Projects definition references a non-existing file or a directory:
    /Users/john/Workspace/x/Unimailbox/apps/worker/apps/worker/vitest.unit.config.ts
  Exit status 1
  ```

  All three of `test`, `test:unit`, `test:worker` in `apps/worker/package.json` are dead, as is
  `test:unit` in `packages/test-kit/package.json:22`. Anyone reaching for the per-package script —
  the normal move when iterating on one package — hits a stack trace that points at a path which
  does not exist.
- **Fix:** Delete the per-package `test*` scripts (the root is the only supported entry point), or
  make the root `projects` entries absolute via
  `fileURLToPath(new URL('./apps/worker/vitest.unit.config.ts', import.meta.url))`.

### M6 — `test/setup.ts` does not do the one thing the contract asks of it

- **Where:** `apps/worker/test/setup.ts:10-14`
- **Failure scenario:** task.md §Scope specifies a setup file that "disables any console output the
  pool would otherwise leak". The file only sets `ENVIRONMENT`. Nothing silences console output, so
  the first capability that logs during a test (`platform/logger.ts` exists and is one JSON line per
  event) will interleave log lines into the vitest reporter, and `.claude/rules/security.md`
  §Logging has no enforcement point in tests. Separately, `declare const process: { env: ... }` at
  `:10` is a hand-written type assertion that `process` exists at runtime; it holds today only
  because `wrangler.jsonc:8` sets `nodejs_compat`. Drop that flag and every worker-pool test fails at
  setup with a bare `ReferenceError: process is not defined` before a single test runs.
- **Fix:** Add the console stub the contract asks for (`vi.spyOn(console, 'log').mockImplementation(() => {})`
  in a `beforeEach`, or `onConsoleLog: () => false` in the project config, which is cleaner). Replace
  the `declare const process` with `import process from 'node:process'`, or guard with
  `if (typeof process !== 'undefined')`. Either way, record the scope drop if the console piece is
  deliberately deferred.

### M7 — Nothing enforces that `FakeClock` and `FixedIdGenerator` satisfy the platform interfaces

- **Where:** `packages/test-kit/src/clock.ts:4-7` and `ids.ts:5-6` (the prose claim);
  `apps/worker/src/platform/clock.test.ts`, `ids.test.ts` (the tests that could enforce it)
- **Failure scenario:** Both test files are co-located as `platform/clock.test.ts` and
  `platform/ids.test.ts` — the convention says a test next to a file tests that file — but neither
  imports `./clock` or `./ids`. They test `@unimailbox/test-kit` exclusively. The claim that the fake
  is structurally compatible with `Clock` / `IdGenerator` lives only in a docstring. I verified with a
  throwaway `tsc` probe inside `apps/worker` that it **does** hold today
  (`const c: Clock = fakeClock(new Date(0))` and `const i: IdGenerator = fixedIds('a')` both
  compile). But when CAP-010 adds a member to `Clock`, `pnpm typecheck` reports nothing here; the
  break surfaces later at an unrelated consumer's call site. The harness ships a promise it does not
  check.
- **Fix:** One line in each test file:
  `it('satisfies the platform Clock interface', () => { const c: Clock = fakeClock(new Date(0)); expect(c.unixMs()).toBe(0); });`
  with `import type { Clock } from './clock'`. Same shape for `IdGenerator`. Cheap, and it makes the
  co-location honest.

### M8 — `fixtures.user().passwordHash` uses a storage format the ADR rejects

- **Where:** `packages/test-kit/src/fixtures.ts:46-47`
- **Failure scenario:** The value is
  `'pbkdf2-sha256$placeholder$placeholder$placeholder$placeholder'` — a `$`-delimited composite
  string. `.claude/rules/security.md` §Passwords (ADR-006) specifies the stored shape as
  `{ algorithm: 'pbkdf2-sha256', iterations, salt, hash }`, and
  `.claude/rules/coding.md` §Data forbids packing structure into a text column (R-DATA-005). Same
  copy-paste dynamic as B2: CAP-010 reads the fixture to learn the shape and builds a parser for a
  format that should not exist, then discovers at CAP-004 review that `users` has four columns.
- **Fix:** Make the fixture reflect ADR-006 — either four fields on `UserRowShape`
  (`passwordAlgorithm`, `passwordIterations`, `passwordSalt`, `passwordHash`) or drop the field
  entirely until CAP-004 fixes the row shape and note the omission in the docstring.

## LOW

- **L1** — `packages/test-kit/src/{clock.ts:40, ids.ts:45, fixtures.ts:78, stubs.ts:124}`,
  `packages/contracts/src/index.ts:59`, `packages/email-core/src/index.ts:23`: trailing `export {}`
  in files that already have exports. It was meaningful in the CAP-001 empty stubs; it is a no-op
  now. Delete.
- **L2** — `packages/test-kit/src/stubs.ts:11-12`: the docstring advertises
  `.on(url, response)` **or** `.on(url, status, body)`. The signature at `:76` is `(url, handler)`
  only; there is no three-argument form. A comment that contradicts the code is worse than none.
- **L3** — `packages/test-kit/src/stubs.ts:43-64`: `stubOutboundAdapter` builds an inner `adapter`
  object and then wraps it in an outer object whose `send` does nothing but `return adapter.send(request)`.
  The indirection has no purpose — inline it. Relatedly, `acceptedAt` at `:49` is a hardcoded
  `'2026-01-01T00:00:00.000Z'`, so two sends are indistinguishable by accepted time; fold this into
  the M3 clock fix if you take it.
- **L4** — `packages/test-kit/src/fixtures.ts:29-31`: `FixtureOverrides<T>` is `Partial<T>` with a
  redundant `readonly`. Use `Partial<T>`; `.claude/rules/coding.md` §Abstraction discipline.
- **L5** — `packages/test-kit/src/ids.ts:35-38`: the `value === undefined` branch is commented
  "Unreachable" and is in fact unreachable given the length check at `:29`. It exists to satisfy
  `noUncheckedIndexedAccess`. `const value = values[index] as string` with the existing guard, or
  restructuring to `values.at(index)`, removes the dead branch. Minor, but it is dead code carrying a
  comment that says so.
- **L6** — Process, not code, and the orchestrator's to fix: CAP-002 is being developed on branch
  `cap/CAP-001-monorepo-scaffold`. `.claude/rules/git.md` §Branches requires one branch per
  capability (`cap/CAP-002-test-harness`), and the commit-scope convention depends on it.

## Not verified

- **The `workers` pool's binding fidelity.** `wrangler.jsonc` carries placeholder IDs
  (`REPLACE_WITH_D1_DATABASE_ID` etc.). The tests pass, so miniflare is clearly simulating locally
  as task.md §Open questions #1 predicted — but I did not confirm that a *migrated* D1 (CAP-004,
  `migrations_dir: '../../migrations'`) resolves correctly through
  `poolOptions.workers.wrangler.configPath` from the `apps/worker` cwd. That path assumption is the
  same class of bug as M5 and is worth a deliberate check when CAP-004 lands its first migration.
- **Isolation between worker-pool tests.** `cache.test.ts:21` deletes its key manually, which
  suggests the author was unsure whether the pool isolates KV per test. I did not verify the
  isolation guarantee for this pool version (0.21.1), so I cannot say whether the `delete` is
  necessary hygiene or cargo cult. If isolation is per-test, remove the line; if it is not, the
  pattern needs to be documented in the test-kit README before CAP-004 copies it.
- **Coverage numbers against a 70% target.** Since the coverage config is inert (H2), there is no
  measured baseline to judge. Re-measure after H2 is fixed.
- **`apps/web` and `packages/config` projects** have zero test files. `vitest run` tolerates this
  today (exit 0), but I did not check whether a future vitest minor turns "no test files in project"
  into an error.

## Required fixes

1. **B1** — `"test:unit": "vitest run --project '!workers'"`; the gate must run all non-worker projects.
2. **B2** — Remove `isAdministrator` from `UserRowShape`; admin identity is the `administrator` role.
3. **H1** — Resolve acceptance #10: istanbul provider for the `workers` project, or amend the criterion.
4. **H2** — Move coverage to the root config; fix the `../../../` email-core path; thresholds to `lines: 70`.
5. **H3** — Add `@unimailbox/test-kit` to `email-core`, `config`, `web`; record the `contracts` cycle exception.
6. **H4** — `router.test.ts`: use `SELF.fetch(...)` or the `env` import; drop the `as unknown as Env` cast.
7. **M1–M8** — as described; M2 (delete `crypto.test.ts`) and M6 (console silencing) are the cheapest wins.
