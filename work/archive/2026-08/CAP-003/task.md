# CAP-003 — `pnpm scaffold doctor` (binding + schema diagnostics)

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

`pnpm scaffold doctor` exits 0 when the repository is in a healthy state and prints a clear, machine-readable list of every problem when it is not. It is the first gate in `.claude/rules/testing.md` §Quality gates, so every later capability's `Implemented` transition depends on it being correct.

## Scope

- **`scripts/doctor.ts`** — single executable TypeScript file (≤ 200 lines per `.claude/rules/coding.md` §Structure). Each check is a small async function returning `{ name: string; ok: boolean; detail?: string }`. The runner iterates checks, prints results, exits 0 if all `ok`, exits 1 if any fail.
- **`pnpm scaffold` script** in root `package.json` — a tiny CLI dispatcher (`pnpm exec tsx scripts/doctor.ts`). Subcommands land later (`pnpm scaffold db:migrate`, etc.) when the migration runner exists; CAP-003 only ships the dispatcher and the `doctor` subcommand.
- **The checks** (each one a separate function in `scripts/doctor.ts`):
  1. **`wrangler-bindings`** — every binding declared in `apps/worker/wrangler.jsonc` exists in the typed `Env` at `apps/worker/src/platform/env.ts`. Names must match exactly: `DB`, `ATTACHMENTS`, `SETUP_SESSION`, `CACHE`, `OUTBOUND`, `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`, `ENVIRONMENT`.
  2. **`wrangler-compat`** — `apps/worker/wrangler.jsonc` declares `compatibility_flags: ["nodejs_compat"]` and a non-empty `compatibility_date` within the last 2 years. Catches drift to legacy runtime.
  3. **`migrations-present`** — for every `migrations/NNNN_*.sql`, a sibling `migrations/NNNN_*.verify.sql` exists. Catches the "deploy without verify" defect that the legacy system had.
  4. **`migrations-ordered`** — migration filenames sort lexicographically and the sequence numbers are zero-padded and contiguous from `0001`. Catches merge-conflict double-numbering.
  5. **`schema-version`** — the latest applied `schema_version` recorded in `installation_state` (or the latest migration's header comment if no DB yet) matches the highest-numbered migration. Catches drift between DB and migration history.
  6. **`module-dependency-zones`** — full per-pair enforcement of the module dependency table in `.claude/rules/architecture.md`. The 132 possible `modules/<a> → modules/<b>` edges are checked against the allowed list. This resolves D-CAP-001-C.
  7. **`eslint-boundary-rules`** — `eslint.config.js` contains the three `import/no-restricted-paths` zones (`integrations` ↛ `modules/http/entrypoints`, `modules` ↛ `entrypoints/http`, `platform` ↛ `entrypoints/http`) plus the `no-restricted-imports` rule for `hono` in `modules/platform/packages`. Catches accidental weakening of the boundary enforcement.
  8. **`tsconfig-strict`** — root `tsconfig.json` has `strict: true` (or every strict-family flag enabled individually) and every per-package `tsconfig.json` inherits `strict`. Catches a future "I'll just relax strict in this package" change.
  9. **`harness-no-placeholders`** — every workspace package's `test:unit` and `test:worker` scripts invoke vitest (no `echo ... && exit 0` placeholders). Catches regression to the CAP-001 placeholder state.
  10. **`tests-cover-contracts`** — every exported zod schema in `packages/contracts/src/index.ts` has at least one `parse` and one `safeParse` test in `packages/contracts/src/index.test.ts`. Names match by file basename.
- **Output format** — for each check, one line:
  - pass: `✓ <name>`
  - fail: `✗ <name> — <detail>`
  - summary: `12/13 checks passed, 1 failed.` (always printed last)
  - exit code 0 if all pass, 1 if any fail
- **`scripts/README.md`** — what each subcommand does. Currently just `doctor`. The file is two paragraphs.

## Out of scope

- The migration runner (`pnpm scaffold db:migrate`). (CAP-004 — that capability owns SQL migrations.)
- Pre-commit hooks or CI integration. (Not in any Phase 0 capability; out of scope.)
- Auto-fix. The doctor only *reports*; it does not *fix*. (Per `.claude/rules/coding.md` §Abstraction discipline: a fix-everything flag is an abstraction without three uses.)
- Performance budgets, bundle-size checks, OTel config. (Phase 6.)
- Any check that requires connecting to a live Cloudflare account. (CAP-005.)

## Business rules

No business rules are *implemented* by CAP-003. The capability's job is to enforce the structural rules that prevent the legacy anti-patterns called out in `.claude/rules/architecture.md` §Legacy anti-patterns from creeping back in.

| Rule | What CAP-003 must enforce |
|---|---|
| Architecture §Forbidden | The `module-dependency-zones` check enforces the module dependency table programmatically. |
| Architecture §Forbidden ("JSON blobs in text columns") | Deferred to CAP-004 — that capability owns the schema and will add a `migrations-no-json-blobs` check. |
| Architecture §Forbidden ("Two parallel sources of authorization truth") | Deferred — there are no `users` rows yet (CAP-004). |
| Testing.md §Quality gates | `pnpm scaffold doctor` is the first listed gate. CAP-003 makes it real. |

## Acceptance criteria

- [ ] 1. `pnpm scaffold doctor` exits 0 on the current repo state.
- [ ] 2. Each of the 10 checks above is individually runnable and reports its name in the output.
- [ ] 3. `pnpm scaffold doctor` exits 1 when at least one check fails. Demonstrate by introducing a temporary bad state (e.g. delete `eslint.config.js`'s `no-restricted-imports` block) and reverting; capture the exit code.
- [ ] 4. `scripts/doctor.ts` is ≤ 200 lines.
- [ ] 5. `scripts/doctor.ts` has zero `any`. Runs under `pnpm typecheck`.
- [ ] 6. `pnpm test:unit` includes a test that runs `pnpm scaffold doctor` (via `child_process.spawnSync`) and asserts the exit code is 0. Test path: `apps/worker/scripts/doctor.test.ts` (new file; the script lives outside the apps so this is a soft exception to "tests live next to code").
- [ ] 7. The doctor is documented in `scripts/README.md`.
- [ ] 8. No new runtime dependency is added to root `package.json`. The script uses `tsx` (already installed for the migration runner's future use), `node:fs`, `node:path`, and zod (via `packages/contracts`).
- [ ] 9. Adding a new module under `apps/worker/src/modules/<name>/` and importing it from a forbidden location causes `module-dependency-zones` to fail. Demonstrate by adding a temporary `modules/<test>/index.ts` and a violating import, then reverting.

## Vertical slice

Layers this touches:

- [x] root config — root `package.json` adds `scaffold` script
- [x] scripts — `scripts/doctor.ts`, `scripts/README.md`
- [x] tests — `apps/worker/scripts/doctor.test.ts` (new test for the script)

New module dependency edges introduced: none. The doctor reads from disk only; it does not import from `apps/worker/src/*` (the module-zone check parses `import` statements with a regex, not via the TypeScript compiler API — keeps the script dependency-free and fast).

## File ownership

One writer for this capability.

| Agent | Owns |
|---|---|
| implementer-1 | Everything in Scope, top to bottom. |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md` (TS strict, no `any`, ≤ 150 lines per file)
- `.claude/rules/architecture.md` (module dependency table — full table is the spec for `module-dependency-zones`)
- `.claude/rules/testing.md` §Quality gates (this doctor is the first listed gate)
- `.claude/rules/documentation.md` §One fact, one home
- `apps/worker/wrangler.jsonc` (binding names)
- `apps/worker/src/platform/env.ts` (typed Env)
- `eslint.config.js` (boundary rules to check)
- `packages/contracts/src/index.ts` (exported zod schemas)

Do not read other `docs/` files.

## Dependencies

- Requires: CAP-001 (workspace, wrangler config), CAP-002 (test harness for the doctor's self-test)
- Blocks: every capability from CAP-004 onwards that uses `pnpm scaffold doctor` as a quality gate

## Decisions made during this capability

| Decision | Options | Default if no answer |
|---|---|---|
| Test location | `apps/worker/scripts/doctor.test.ts` vs `scripts/__tests__/doctor.test.ts` | `apps/worker/scripts/doctor.test.ts` — the test lives next to a consumer of `scripts/`, and the apps/worker project already has vitest configured |
| Import-statement parsing | regex (simple) vs TypeScript compiler API (correct but slow + heavy dep) | regex — keeps the script dep-free and fast. False positives are acceptable for a doctor; false negatives are caught by `import/no-restricted-paths` in eslint |
| Auto-fix | none vs safe auto-fix for some checks | none — a fix flag is an abstraction without three concrete uses (Rule of Three) |
| Output format | text vs JSON | text for humans; JSON is added if a CI consumer requests it later |

## Open questions

Blockers needing the operator.

1. Should `pnpm scaffold doctor` *also* be wired as a pre-commit hook, or does that wait for a CI capability? Default: not in this slice. CAP-005 or later.
2. Should the `module-dependency-zones` check whitelist any edges beyond the architecture table? Default: no whitelisting. If the table permits an edge, the check passes. If the table forbids it, the check fails.